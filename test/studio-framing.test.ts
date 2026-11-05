import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { semanticAnchors, trackClip } from '../src/main/studio/tracking';
import { buildClipJob } from '../src/main/studio/render';
import { getStyle } from '../src/main/studio/styles';
import type { ReelClip } from '../src/shared/studio';

test('semantic player locations reject missing, uncertain and invented coordinates', () => {
  assert.deepEqual(semanticAnchors({ frames: [
    { index: 0, x: .38, confidence: .9, visible: true },
    { index: 1, x: .8, confidence: .3, visible: true },
    { index: 2, x: .6, confidence: .95, visible: false },
    { index: 3, x: 99, confidence: 1, visible: true },
    { index: 4, x: .47, confidence: .8, visible: true },
  ] }, [0, 1, 2, 3, 4]), [
    { t: 0, x: .38 }, { t: 1, x: .38 }, { t: 2, x: .38 }, { t: 3, x: .38 }, { t: 4, x: .47 },
  ]);
});

test('an explicitly moved manual crop never calls the AI or media tracker', async () => {
  const ai = { status: async () => { throw new Error('must not request AI'); }, ask: async () => { throw new Error('must not request AI'); } };
  assert.deepEqual(await trackClip('missing-ffmpeg', { cropX: .36 } as ReelClip, undefined, ai), []);
});

const ffmpeg = process.env.FFMPEG || 'ffmpeg';
let available = true;
try { execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' }); } catch { available = false; }

for(const outputHeight of [568,320]) test(`clean layout at 320x${outputHeight} removes the timer and keeps the feed on source time through retiming`, { skip: !available }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-feed-layout-'));
  try {
    const source = path.join(dir, 'source.mp4');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=blue:s=1000x500:r=30:d=2', '-vf',
      "drawbox=x=0:y=0:w=iw:h=50:c=red:t=fill,drawbox=x=0:y=450:w=iw:h=50:c=yellow:t=fill,drawbox=x=900:y=15:w=80:h=30:c=green:t=fill,drawbox=x=900:y=15:w=80:h=30:c=white:t=fill:enable='gte(t,1)'",
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
    const clip: ReelClip = { uid: 'layout', clipId: 'layout', videoFile: source, durationSec: 2, width: 1000, height: 500, fps: 30,
      hasMic: false, hits: [1], in: 0, out: 2, useMic: false, cropX: .5, cropY: .5, cropZoom: 1, kills: 1, score: 1, tags: [] };
    const job = buildClipJob({ clip, audioCount: 0, segments: [{ clipUid: 'layout', clipIndex: 0, kind: 'lead', src: [.4, 1.4], out: [0, .5], speed: 2 }],
      size: { width: 320, height: outputHeight }, fps: 30, style: getStyle('raw'), preview: true, workDir: dir });
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-filter_complex', job.filter, ...job.args]);
    const sample = (time: number, x: number, y: number) => {
      const rgb = execFileSync(ffmpeg, ['-v', 'error', '-ss', String(time), '-i', job.output, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
      const i = (Math.round(y * outputHeight) * 320 + Math.round(x * 320)) * 3;
      return [...rgb.subarray(i, i + 3)];
    };
    const top = sample(.1, .5, .02);
    assert.ok(top[2] > 180 && top[0] < 50, `clock should be removed, received ${top}`);
    const before = sample(.1, .78, .09), after = sample(.4, .78, .09);
    assert.ok(before[1] > before[0] + 50 && before[1] > before[2] + 50, `feed before source transition: ${before}`);
    assert.ok(after.every(v => v > 200), `feed after retimed source transition: ${after}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
