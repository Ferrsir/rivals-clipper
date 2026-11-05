// End-to-end: render real reels with ffmpeg and check what comes out.
// Catches broken filter graphs, wrong sizes, missing audio and drift between the plan and the file.
// Needs ffmpeg and ffprobe (on PATH, or FFMPEG / FFPROBE). On CI a missing ffmpeg fails instead of skipping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ReelClip, ReelProject } from '../src/shared/studio';
import { analyzeSamples } from '../src/main/studio/beats';
import { findFont, outputSize, planFor, renderProject } from '../src/main/studio/pipeline';
import { createProject } from '../src/main/studio/projects';
import { STYLES, clone, getStyle } from '../src/main/studio/styles';
import { FORMATS } from '../src/main/studio/formats';
import { synthTrack } from './studio-synth';
import { exportClip } from '../src/main/ffmpeg';

function findTool(name: 'ffmpeg' | 'ffprobe'): string | undefined {
  const env = process.env[name.toUpperCase()];
  if (env && fs.existsSync(env)) return env;
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return name;
  } catch {
    return undefined;
  }
}

const FF = findTool('ffmpeg');
const PROBE = findTool('ffprobe');
// Without ffmpeg the render tests skip; on CI the check below fails instead, so a missing ffmpeg can't pass quietly.
const skip = !FF || !PROBE ? 'ffmpeg/ffprobe not installed' : false;
if (process.env.CI && (!FF || !PROBE)) test('ffmpeg is available on CI', () => assert.fail('ffmpeg and ffprobe are needed for the render tests'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-render-'));

test('silent video exports in Library and Studio even with stale audio metadata', { skip, timeout: 120_000 }, async () => {
  const file = path.join(dir, 'silent.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
  const exported = await exportClip(FF!, file, dir, { withMic: true, hasMicTrack: true });
  assert.equal(probe(exported).streams.filter(s => s.codec_type === 'video').length, 1);
  assert.equal(probe(exported).streams.filter(s => s.codec_type === 'audio').length, 0);
  const p = createProject({ name: 'Silent', styleId: 'raw' });
  p.clips = [{ uid: 'silent', clipId: 'silent', cropX: 0.5, cropY: 0.5, cropZoom: 1, videoFile: file, durationSec: 2, width: 320, height: 180, fps: 30, kills: 0, score: 0,
    tags: [], hits: [], in: 0, out: 2, hasMic: true, useMic: true }];
  const files = await renderProject({ ffmpeg: FF!, project: p, analysis: null,
    req: { preview: true, formats: [p.format], noMusicCopy: false, gpu: false },
    studioDir: path.join(dir, 'silent-studio'), reelsDir: path.join(dir, 'silent-reels'), encoder: { name: 'libx264' }, onProgress() {} });
  assert.equal(probe(files[0]).streams.filter(s => s.codec_type === 'video').length, 1);
  assert.equal(probe(files[0]).streams.filter(s => s.codec_type === 'audio').length, 1);
  ff(['-i', files[0], '-f', 'null', '-']);
});
const SR = 11025;
let musicFile = '';
let analysis: ReturnType<typeof analyzeSamples> | null = null;

function ff(args: string[]) {
  execFileSync(FF!, ['-v', 'error', '-y', ...args], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
}

/** A gameplay-like clip: moving test pattern, game audio on track 1 and a "mic" on track 2. */
function makeClip(n: number, seconds: number): string {
  const f = path.join(dir, `clip${n}.mp4`);
  if (!fs.existsSync(f))
    ff([
      '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${seconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=${300 + n * 100}:sample_rate=48000:duration=${seconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=900:sample_rate=48000:duration=${seconds}`,
      '-map', '0:v', '-map', '1:a', '-map', '2:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f,
    ]);
  return f;
}

function setup() {
  if (analysis) return;
  const samples = synthTrack(128, 40, { quietBars: 4, sr: SR });
  const raw = path.join(dir, 'music.f32');
  fs.writeFileSync(raw, Buffer.from(samples.buffer));
  musicFile = path.join(dir, 'music.wav');
  ff(['-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', raw, '-ar', '48000', '-ac', '2', musicFile]);
  analysis = analyzeSamples(samples);
}

function clip(n: number, hits: number[], score: number, extra: Partial<ReelClip> = {}): ReelClip {
  return {
    uid: `u${n}-${Math.random().toString(36).slice(2, 7)}`,
    clipId: `c${n}`,
    videoFile: makeClip(n, 8),
    hero: ['Hela', 'Magik', 'Star-Lord'][n % 3],
    kills: hits.length,
    score,
    tags: [],
    durationSec: 8,
    width: 640,
    height: 360,
    fps: 30,
    hasMic: true,
    hits,
    in: 0,
    out: 8,
    useMic: n === 2,
    cropX: 0.5,
    cropY: 0.5,
    cropZoom: 1,
    ...extra,
  };
}

function project(styleId: string, opts: { music?: boolean; intro?: boolean; format?: keyof typeof FORMATS } = {}): ReelProject {
  setup();
  const p = createProject({ name: `Render ${styleId}`, styleId, format: opts.format ?? 'tiktok' });
  p.clips = [clip(1, [4.1], 20), clip(2, [3.5, 4.4], 40), clip(3, [3.2, 4.0, 4.9], 200)];
  if (opts.music !== false) p.music = { trackId: 'm', file: musicFile, title: 'Synth', start: 'auto' };
  p.captions = [{ text: 'They said Hela was a support' }, { text: 'They were wrong' }, { text: 'Watch this' }];
  if (opts.intro) {
    p.intro = { text: "Who's stronger?\nHim?\nOr you?", seconds: 3, layout: 'band' };
    p.outro = { text: 'Comment who wins', seconds: 2 };
  }
  return p;
}

interface Probe {
  streams: Array<{ codec_type: string; width?: number; height?: number; r_frame_rate?: string }>;
  format: { duration: string };
}
function probe(file: string): Probe {
  return JSON.parse(execFileSync(PROBE!, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());
}

/** Mean loudness of the file's first audio track in dB (silence is about -91). */
function meanVolume(file: string): number {
  const r = spawnSync(FF!, ['-hide_banner', '-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr ?? '');
  return m ? Number(m[1]) : -Infinity;
}

async function render(p: ReelProject, req: { preview: boolean; formats?: string[]; noMusicCopy?: boolean }) {
  const studioDir = path.join(dir, 'studio');
  const reelsDir = path.join(dir, 'reels');
  const stages: string[] = [];
  const files = await renderProject({
    ffmpeg: FF!,
    project: p,
    analysis: p.music ? analysis : null,
    req: { preview: req.preview, formats: (req.formats ?? [p.format]) as any, noMusicCopy: !!req.noMusicCopy, gpu: false },
    studioDir,
    reelsDir,
    fontFile: findFont(),
    encoder: { name: 'libx264' },
    onProgress: (x) => stages.push(x.stage),
  });
  return { files, stages };
}

function checkVideo(file: string, size: { width: number; height: number }, expectSeconds: number) {
  assert.ok(fs.existsSync(file), `missing ${file}`);
  const pr = probe(file);
  const v = pr.streams.find((s) => s.codec_type === 'video');
  const a = pr.streams.find((s) => s.codec_type === 'audio');
  assert.ok(v, 'no video stream');
  assert.ok(a, 'no audio stream');
  assert.equal(v.width, size.width);
  assert.equal(v.height, size.height);
  const dur = Number(pr.format.duration);
  assert.ok(Math.abs(dur - expectSeconds) < 0.25, `duration ${dur} vs planned ${expectSeconds}`);
}

for (const style of STYLES) {
  test(`preview renders: ${style.name}`, { skip, timeout: 240_000 }, async () => {
    const p = project(style.id, { intro: style.id === 'story' });
    const { files } = await render(p, { preview: true });
    const f = FORMATS[p.format];
    const tl = planFor(p, analysis, 30, f.maxSeconds);
    assert.equal(files.length, 1);
    checkVideo(files[0], outputSize(f, true), tl.duration);
  });
}

test('final export: two formats, the copy without music, and the right sizes', { skip, timeout: 600_000 }, async () => {
  const p = project('velocity');
  // Shorter clips keep this quick at full resolution.
  p.clips = p.clips.slice(1);
  const { files } = await render(p, { preview: false, formats: ['tiktok', 'youtube'], noMusicCopy: true });
  const music = files.filter((f) => !f.includes('_nomusic'));
  const noMusic = files.filter((f) => f.includes('_nomusic'));
  assert.equal(music.length, 2, files.join(', '));
  assert.equal(noMusic.length, 2, files.join(', '));
  for (const file of files) {
    const fmt = file.includes('_youtube') ? FORMATS.youtube : FORMATS.tiktok;
    const tl = planFor(p, analysis, fmt.fps, fmt.maxSeconds);
    checkVideo(file, outputSize(fmt, false), tl.duration);
    assert.ok(meanVolume(file) > -40, `${path.basename(file)} is silent`);
    assert.match(probe(file).streams.find((s) => s.codec_type === 'video')!.r_frame_rate!, new RegExp(`^${fmt.fps}/1$`));
  }
});

test('raw style without music keeps game audio and real time', { skip, timeout: 240_000 }, async () => {
  const p = project('raw', { music: false });
  const { files } = await render(p, { preview: true });
  const tl = planFor(p, null, 30, FORMATS.tiktok.maxSeconds);
  checkVideo(files[0], outputSize(FORMATS.tiktok, true), tl.duration);
  assert.ok(meanVolume(files[0]) > -40, 'game audio is missing');
});

test('a punched-in, off-centre crop and a muted clip still render', { skip, timeout: 240_000 }, async () => {
  const p = project('beat-cuts');
  p.clips[0] = { ...p.clips[0], cropX: 0.05, cropY: 0.9, cropZoom: 2.2, muteGame: true };
  p.clips[1] = { ...p.clips[1], in: 2, out: 6, hits: [3.5, 4.4] };
  p.style = clone(getStyle('beat-cuts'));
  const { files } = await render(p, { preview: true, formats: ['youtube'] });
  const tl = planFor(p, analysis, 30, FORMATS.youtube.maxSeconds);
  checkVideo(files[0], outputSize(FORMATS.youtube, true), tl.duration);
});

test('cancelling during final assembly leaves no completed-looking or partial MP4', { skip, timeout: 240_000 }, async () => {
  const p = project('raw', { music: false });
  p.clips = p.clips.slice(0, 1);
  const ac = new AbortController();
  const studioDir = path.join(dir, 'cancel-studio');
  const reelsDir = path.join(dir, 'cancel-reels');
  let assembling = false;
  await assert.rejects(renderProject({
    ffmpeg: FF!, project: p, analysis: null,
    req: { preview: false, formats: ['tiktok'], noMusicCopy: false, gpu: false },
    studioDir, reelsDir, encoder: { name: 'libx264' }, signal: ac.signal,
    onProgress: progress => { if (progress.stage === 'assemble') { assembling = true; ac.abort(); } },
  }), /cancelled/);
  assert.equal(assembling, true);
  assert.deepEqual(fs.readdirSync(reelsDir), []);
});

test('a cancelled render never starts a cached or new export', { skip }, async () => {
  const p = project('raw', { music: false });
  const ac = new AbortController();
  ac.abort();
  const reelsDir = path.join(dir, 'pre-cancelled-reels');
  await assert.rejects(renderProject({
    ffmpeg: FF!, project: p, analysis: null,
    req: { preview: false, formats: ['tiktok'], noMusicCopy: false, gpu: false },
    studioDir: path.join(dir, 'pre-cancelled-studio'), reelsDir,
    encoder: { name: 'libx264' }, signal: ac.signal, onProgress: () => assert.fail('render started after cancellation'),
  }), /cancelled/);
  assert.equal(fs.existsSync(reelsDir), false);
});
