// What Ferris asked for on 2026-11-05: requested length is honoured by pulling in more clips,
// the whole kill feed sits as one box in the top-right corner, the hero stays centred,
// and his own clips/pictures can be used (picture over a face, subtitles).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ClipSidecar } from '../src/shared/types';
import type { MusicAnalysis, ReelProject } from '../src/shared/studio';
import { describeFit, fitToTarget, requestedSeconds } from '../src/main/studio/fit';
import { feedBox, buildClipJob } from '../src/main/studio/render';
import { createProject, externalClip, projectFromIdea, reelClipFromSidecar, sanitizeProject } from '../src/main/studio/projects';
import { sanitizeIdeas } from '../src/main/studio/ideas';
import { FORMATS } from '../src/main/studio/formats';
import { getStyle } from '../src/main/studio/styles';
import { plan } from '../src/main/studio/planner';
import { subtitleTimes } from '../src/main/studio/pipeline';
import { faceKeys, overlayFilters } from '../src/main/studio/overlay';
import { parseProbe } from '../src/main/studio/assets';
import { reviseReel } from '../src/main/studio/ai';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-requests-'));
function lib(id: string, hits: number[], score: number, hero = 'MAGIK'): ClipSidecar {
  const file = path.join(dir, `${id}.mp4`);
  fs.writeFileSync(file, '');
  return { version: 1, id, videoFile: file, createdAt: 1, startTimeEpoch: 0, durationMs: (hits.at(-1)! + 4) * 1000, trigger: 'auto', hero, match: {}, events: hits.map((h) => ({ type: 'kill', at: h * 1000 })), ultUsedBeforeKills: false, video: { width: 1920, height: 1080, fps: 60 }, audioTracks: [{ index: 0, label: 'game' }], useMic: false, score, tags: [], scoreBreakdown: {} } as unknown as ClipSidecar;
}
function grid(bpm = 128, seconds = 120): MusicAnalysis {
  const step = 60 / bpm;
  const beats = Array.from({ length: Math.floor(seconds / step) }, (_, i) => Math.round(i * step * 1000) / 1000);
  return { version: 1, durationSec: seconds, bpm, beats, downbeats: beats.filter((_, i) => i % 4 === 0), beatEnergy: beats.map(() => 0.5), drops: [beats[64]], energy: 0.7, confidence: 0.9, peaks: [] };
}

test('the length in the prompt is read in the ways people write it', () => {
  assert.equal(requestedSeconds('make it closer to 30 seconds'), 30);
  assert.equal(requestedSeconds('a 45-second Magik edit'), 45);
  assert.equal(requestedSeconds('20-30s please'), 30);
  assert.equal(requestedSeconds('about half a minute'), 30);
  assert.equal(requestedSeconds('a 1 minute montage'), 60);
  assert.equal(requestedSeconds('add more clips'), undefined);
  assert.equal(requestedSeconds('my 3 best kills'), undefined);
});

test('a reel that comes back short pulls more kill clips from the library until it reaches the target', () => {
  const library = [lib('a', [3, 3.8], 50), lib('b', [3], 40), lib('c', [3, 4, 5], 90), lib('d', [3], 30), lib('e', [3, 3.6], 60), lib('f', [3], 20), lib('g', [3, 4], 45), lib('h', [3], 35, 'HELA'), lib('i', [3], 33), lib('j', [3, 3.5], 41), lib('k2', [3], 25)];
  const p = createProject({ format: 'square' });
  p.clips = [reelClipFromSidecar(library[2])];
  p.music = { trackId: 't', file: '/m.mp3', title: 'Song', start: 'auto' };
  p.targetSeconds = 30;
  const before = plan({ clips: p.clips, style: p.style, fps: 30, analysis: grid() }).duration;
  assert.ok(before < 10, `starts short (${before})`);
  const r = fitToTarget(p, library, grid());
  assert.ok(r.added.length >= 3, `added ${r.added.length}`);
  assert.ok(r.seconds >= 30 - 2.1 && r.seconds <= 31, `lands near 30 s, got ${r.seconds}`);
  assert.equal(r.project.clips.at(-1)!.clipId, 'c', 'the best play still closes the reel');
  assert.match(describeFit(r, 30), /added \d+ more kill clips/);
  // Same hero first.
  assert.ok(!r.added.slice(0, 3).includes('h'));
});

test('a reel over its target drops the weakest clips but never the closer', () => {
  const library = Array.from({ length: 12 }, (_, i) => lib(`x${i}`, [3, 3.7], 10 + i));
  const p = createProject({ format: 'square' });
  p.clips = library.map(reelClipFromSidecar);
  p.music = { trackId: 't', file: '/m.mp3', title: 'Song', start: 'auto' };
  p.targetSeconds = 15;
  const r = fitToTarget(p, library, grid());
  assert.ok(r.seconds <= 16, `fits: ${r.seconds}`);
  assert.equal(r.project.clips.at(-1)!.clipId, 'x11');
  assert.ok(r.removed.includes('x0'));
});

test('the default style cuts right after the last kill and lands kills on beats', () => {
  const style = getStyle('montage');
  assert.ok(style.tail[1] <= 0.8 && style.beatSync);
  const c = reelClipFromSidecar(lib('t', [3, 4.2], 50));
  const tl = plan({ clips: [c, { ...c, uid: 'two' }], style, fps: 30, analysis: grid() });
  const lastKill = tl.clips[0].kills.at(-1)!;
  assert.ok(tl.clips[0].out[1] - lastKill <= style.slowmo.after / style.slowmo.speed + style.tail[1] + 0.05, 'clip ends right after its last kill');
  assert.ok(tl.cuts.every((cut) => tl.beats.some((b) => Math.abs(b - cut) < 0.04)), 'every cut is on a beat');
});

test('new projects open on gameplay with no text, centred on the hero', () => {
  const p = createProject();
  assert.equal(p.style.id, 'montage');
  assert.equal(p.intro, null);
  assert.deepEqual(p.captions, []);
  const c = sanitizeProject({ ...p, clips: [reelClipFromSidecar(lib('z', [3], 10))] }).clips[0];
  assert.equal(c.followCharacter, false);
  assert.equal(c.cropX, 0.5);
});

test('the kill feed is one box flush with the top-right corner, bigger on vertical outputs', () => {
  const sq = feedBox({ width: 1080, height: 1080 });
  assert.equal(sq.x + sq.width, 1080);
  assert.equal(sq.y, 0);
  assert.ok(sq.width >= 1080 * 0.4);
  const tall = feedBox({ width: 1080, height: 1920 });
  assert.ok(tall.width > sq.width);
  assert.ok(tall.y > 0, 'below the app buttons on TikTok');
  const job = buildClipJob({ clip: reelClipFromSidecar(lib('k', [3], 10)), audioCount: 1, segments: [{ clipUid: 'x', clipIndex: 0, kind: 'lead', src: [0, 3], out: [0, 3], speed: 1 }], size: { width: 1080, height: 1080 }, fps: 30, style: getStyle('montage'), preview: true, workDir: dir });
  assert.match(job.filter, /\[feedSrc\]crop=/);
  assert.doesNotMatch(job.filter, /alphamerge/, 'no row isolation: the whole feed is one subject');
});

test('your own video, a picture over a face and subtitles come through the AI plan', () => {
  const library = [lib('a', [3], 50)];
  const video = path.join(dir, 'mine.mp4');
  const picture = path.join(dir, 'face.png');
  fs.writeFileSync(video, '');
  fs.writeFileSync(picture, '');
  const assets = [{ id: 'v1', kind: 'video' as const, file: video, name: 'mine.mp4', durationSec: 6, width: 1920, height: 1080 }, { id: 'p1', kind: 'image' as const, file: picture, name: 'face.png' }];
  const raw = { ideas: [{ title: 'Mine', clipIds: ['asset:v1', 'a'], overlays: [{ assetId: 'asset:p1', onClip: 'asset:v1', from: 1, to: 4, anchor: 'face', x: 0.5, y: 0.3, size: 0.1 }], subtitles: [{ onClip: 'asset:v1', from: 1, to: 2.5, text: 'no way' }] }] };
  const [idea] = sanitizeIdeas(raw, library, [], FORMATS.square, assets, 'use my clip, put the picture over his face, subtitles: no way');
  const p = projectFromIdea(idea, library, []);
  assert.equal(p.clips[0].external, true);
  assert.equal(p.clips[0].preserveKillFeed, false);
  assert.equal(p.overlays![0].clipUid, p.clips[0].uid);
  assert.equal(p.overlays![0].image, picture);
  assert.equal(p.subtitles![0].text, 'no way');
  const tl = plan({ clips: p.clips, style: p.style, fps: 30 });
  const subs = subtitleTimes(p, tl);
  if (tl.segments.some((s) => s.clipUid === p.clips[0].uid && s.src[0] <= 1 && s.src[1] >= 2.5)) assert.equal(subs.length, 1);
});

test('face keys hold the last good location and drop invented ones', () => {
  const keys = faceKeys({ frames: [{ index: 0, x: 0.4, y: 0.3, size: 0.1, visible: true }, { index: 1, visible: false }, { index: 2, x: 7, y: 0.3, size: 0.1, visible: true }] }, [0, 1, 2], { x: 0.5, y: 0.5, size: 0.2 });
  assert.deepEqual(keys.map((k) => k.x), [0.4, 0.4, 0.4]);
  assert.ok(Math.abs(keys[0].size - 0.125) < 1e-9, 'padded so it covers the whole face');
});

test('ffmpeg probe output is read for dropped files', () => {
  const info = parseProbe("  Duration: 00:00:12.48, start: 0.000000, bitrate: 900 kb/s\n  Stream #0:0[0x1](und): Video: h264 (High), yuv420p(tv, bt709), 1920x1080 [SAR 1:1 DAR 16:9], 60 fps\n  Stream #0:1[0x2](und): Audio: aac (LC), 48000 Hz, stereo");
  assert.deepEqual(info, { durationSec: 12.48, width: 1920, height: 1080, hasAudio: true });
});

test('revisions really add library clips when asked for more length', async () => {
  const library = [lib('a', [3], 50), lib('b', [3], 40), lib('c', [3], 30)];
  const p: ReelProject = { ...createProject({ format: 'square' }), clips: [reelClipFromSidecar(library[0])] };
  const ai = { status: async () => ({ signedIn: true, provider: 'claude' }), ask: async () => ({ text: '', json: { clips: [{ clipId: 'b' }, { uid: p.clips[0].uid }], targetSeconds: 30, summary: 'Added b.' } }) } as any;
  const r = await reviseReel(ai, p, 'make it closer to 30 seconds and add more clips', library);
  assert.deepEqual(r.project.clips.map((c) => c.clipId), ['b', 'a']);
  assert.equal(r.project.targetSeconds, 30);
});

const ffmpeg = process.env.FFMPEG || 'ffmpeg';
let available = true;
try { execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' }); } catch { available = false; }

test('a picture overlay follows the face keyframes in the rendered clip', { skip: !available }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-'));
  try {
    const src = path.join(work, 'src.mp4');
    const img = path.join(work, 'img.png');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=blue:s=640x360:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=red:s=64x64', '-frames:v', '1', img]);
    const clip = { ...externalClip({ id: 'v', kind: 'video', file: src, name: 'src', durationSec: 2, width: 640, height: 360 }), uid: 'v' };
    const overlays = [{ id: 'o', image: img, clipUid: 'v', from: 0, to: 2, anchor: 'face' as const, x: 0.5, y: 0.5, size: 0.2, shape: 'square' as const, track: [{ t: 0, x: 0.3, y: 0.5, size: 0.2 }, { t: 2, x: 0.7, y: 0.5, size: 0.2 }] }];
    assert.equal(overlayFilters({ overlays, clip, firstInput: 1, offset: 0, span: 2, fps: 30, inLabel: 'a', outLabel: 'b' }).inputs.length, 1);
    const job = buildClipJob({ clip, overlays, audioCount: 0, segments: [{ clipUid: 'v', clipIndex: 0, kind: 'plain', src: [0, 2], out: [0, 2], speed: 1 }], size: { width: 640, height: 360 }, fps: 30, style: getStyle('raw'), preview: true, workDir: work });
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-filter_complex', job.filter, ...job.args]);
    const px = (time: number, x: number) => {
      const rgb = execFileSync(ffmpeg, ['-v', 'error', '-ss', String(time), '-i', job.output, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
      const i = (180 * 640 + Math.round(x * 640)) * 3;
      return [...rgb.subarray(i, i + 3)];
    };
    assert.ok(px(0.05, 0.3)[0] > 180, 'starts on the left face position');
    assert.ok(px(1.9, 0.7)[0] > 180, 'ends on the right face position');
    assert.ok(px(1.9, 0.3)[2] > 180, 'and has left the old spot');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});
