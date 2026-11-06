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

test('scoreboard frames are recognised from their dark, grey look', async () => {
  const { frameStats, isScoreboard, trimAround } = await import('../src/main/studio/clip-filter');
  const fill = (r: number, g: number, b: number) => { const a = new Uint8Array(10 * 4 * 3); for (let i = 0; i < a.length; i += 3) { a[i] = r; a[i + 1] = g; a[i + 2] = b; } return a; };
  assert.ok(isScoreboard(frameStats(fill(40, 42, 46), 10, 4)));
  assert.ok(isScoreboard(frameStats(fill(22, 34, 48), 10, 4)), 'tinted panel still counts');
  assert.ok(!isScoreboard(frameStats(fill(90, 110, 70), 10, 4)));
  assert.ok(!isScoreboard(frameStats(fill(30, 45, 80), 10, 4)), 'dark but colourful gameplay is kept');
  const { heldRuns } = await import('../src/main/studio/clip-filter');
  assert.deepEqual(heldRuns([false, true, false, true, true, false]), [0.75, 1], 'a single dark sample is ignored');
  const c = { in: 0, out: 7, hits: [4] };
  assert.deepEqual(trimAround(c, [0.5, 1, 1.5]), { in: 1.8, out: 7, hits: [4] }, 'trimmed off before the kill');
  assert.equal(trimAround(c, [3.5]), null, 'too close to the kill: drop the clip');
  assert.deepEqual(trimAround(c, [6]), { in: 0, out: 5.7, hits: [4] }, 'cut a whole sample before the scoreboard');
});

test('game crops frame the hero left of the crosshair; a hand-moved crop wins', async () => {
  const { cropFilter } = await import('../src/main/studio/render');
  const base = { cropX: 0.5, cropY: 0.5, cropZoom: 1 };
  assert.match(cropFilter(base, { width: 1080, height: 1080 }, 0, 0.2), /iw\/2-ih\*0\.2-ow\/2/);
  assert.doesNotMatch(cropFilter({ ...base, cropX: 0.3 }, { width: 1080, height: 1080 }, 0, 0.2), /ih\*0\.2/);
});

test('the feed box shows only while kills are in the game feed, and fades', async () => {
  const { feedWindows, feedAlphaExpr, FEED_HOLD } = await import('../src/main/studio/render');
  assert.deepEqual(feedWindows([], 10, 6), []);
  assert.deepEqual(feedWindows([12, 13], 10, 20), [[1.85, 3 + FEED_HOLD]], 'chained kills share one window');
  assert.deepEqual(feedWindows([11, 30], 10, 8), [[0.85, 1 + FEED_HOLD]], 'kills outside the clip are ignored');
  assert.equal(feedAlphaExpr([]), '0');
  assert.match(feedAlphaExpr([[1, 2], [5, 6]]), /^255\*max\(clip/);
});

test('own kill-feed rows are told apart from teammates\' rows and scenery', async () => {
  const { slotStats, isOwnRow } = await import('../src/main/studio/feed-rows');
  const W = 120, H = 30;
  const frame = (paint: (i: number, j: number) => [number, number, number]) => {
    const a = new Uint8Array(W * H * 3);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) a.set(paint(i, j), (j * W + i) * 3);
    return a;
  };
  // Slot 0: your white plate from x 46 to 117 in its top 3 px rows (about the measured 0.16 share).
  // Slot 1: another player's dark plate with blue text. Slot 2: a bright sign at the left.
  const rgb = frame((i, j) => (j < 3 && i >= 46 && i <= 117 ? [235, 235, 235] : j >= 10 && j < 16 && i >= 46 ? (i % 4 ? [20, 20, 30] : [60, 120, 230]) : j >= 20 && j < 26 && i < 42 ? [240, 240, 240] : [40, 50, 60]));
  const s = slotStats(rgb, W, H);
  assert.ok(isOwnRow(s[0]), `own row ${JSON.stringify(s[0])}`);
  assert.ok(s[0].x0 > 0.36 && s[0].x0 < 0.4 && s[0].x1 > 0.97, 'plate edges');
  assert.ok(!isOwnRow(s[1]), 'teammate row');
  assert.ok(!isOwnRow(s[2]), 'scenery that does not reach the right edge');
});

test('kills move to when your row appears; teammates\' kills are dropped', async () => {
  const { ownRows, rowOnsets, withFeedRows } = await import('../src/main/studio/feed-rows');
  // 22-36-48 as measured: Deadpool enters the top at 2.0 s, Angela at 4.0 s (Deadpool slides to slot 1),
  // CorrinMa's Mister Fantastic takes the top at 6.5 s. Sidecar hits: 3.00, 4.30, 7.03.
  const samples = Array.from({ length: 44 }, (_, f) => {
    const t = f / 4;
    const own: Array<number | null> = [null, null, null];
    if (t >= 2 && t < 3.75) own[0] = 0.38;
    if (t >= 3.75 && t < 6.25) own[1] = 0.38;
    if (t >= 4 && t < 6.5) own[0] = 0.3;
    if (t >= 6.5 && t < 8.25) own[1] = 0.3;
    if (t >= 6.5 && t < 6.75) own[2] = 0.38;
    return { t, own };
  });
  assert.deepEqual(rowOnsets(samples), [1.875, 3.875]);
  const clip = withFeedRows({ hits: [3, 4.3, 7.03], kills: 3 }, samples);
  assert.deepEqual(clip.hits, [1.875, 3.875]);
  assert.equal(clip.kills, 2);
  const rows = ownRows(samples);
  assert.ok(rows.every((r) => r.to - r.from >= 0.3), 'single-sample flashes are not rows');
  assert.ok(rows.some((r) => r.slot === 0 && r.from === 2 && Math.abs(r.to - 3.6) < 1e-9));
  assert.deepEqual(withFeedRows({ hits: [3], kills: 1 }, []), { hits: [3], kills: 1 }, 'scan failed: keep the clip as it was');
  const none = withFeedRows({ hits: [3], kills: 1 }, samples.map((s) => ({ ...s, own: [null, null, null] })));
  assert.deepEqual([none.hits, none.kills], [[], 0], 'every row is a teammate\'s: no kills of yours');
});

test('the feed box shows only your rows, on black', { skip: !available }, () => {
  const ff = ffmpeg;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-own-rows-'));
  try {
    const source = path.join(dir, 's.mp4');
    // 1000x500 source; the feed crop is x 755-982, y 12-67. A white "own" row in slot 0, an orange "other" row in slot 1.
    execFileSync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=0x3070c0:s=1000x500:r=30:d=2', '-vf', 'drawbox=x=800:y=14:w=180:h=12:c=white:t=fill,drawbox=x=800:y=33:w=180:h=12:c=orange:t=fill', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
    const clip = { uid: 'r', clipId: 'r', videoFile: source, durationSec: 2, width: 1000, height: 500, fps: 30, hasMic: false, hits: [0.5], in: 0, out: 2, useMic: false, cropX: .5, cropY: .5, cropZoom: 1, kills: 1, score: 1, tags: [],
      feedRows: [{ slot: 0, from: 0, to: 2, x0: 0.15 }] };
    const size = { width: 320, height: 320 };
    const job = buildClipJob({ clip, audioCount: 0, segments: [{ clipUid: 'r', clipIndex: 0, kind: 'lead', src: [0.4, 1.4], out: [0, 1], speed: 1 }], size, fps: 30, style: getStyle('raw'), preview: true, workDir: dir });
    execFileSync(ff, ['-v', 'error', '-y', '-filter_complex', job.filter, ...job.args]);
    const rgb = execFileSync(ff, ['-v', 'error', '-ss', '0.5', '-i', job.output, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    const box = feedBox(size);
    const px = (fx: number, fy: number) => { const i = (Math.round(box.y + fy * box.height) * 320 + Math.round(box.x + fx * box.width)) * 3; return [...rgb.subarray(i, i + 3)]; };
    const cropX0 = 1000 - 500 * 0.49;
    const at = (x: number, y: number) => px((x - cropX0) / (500 * 0.454), (y - 12.5) / 55);
    assert.ok(at(900, 20).every((v) => v > 200), `own row shown: ${at(900, 20)}`);
    const other = at(900, 39);
    assert.ok(!(other[0] > 200 && other[2] < 90), `other player's row hidden: ${other}`);
    assert.ok(other[2] > 90, `no black slab where you have no row (the game shows through): ${other}`);
    assert.ok(!at(770, 20).every((v) => v < 40), `left of your row the game shows through: ${at(770, 20)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the kill feed stays on screen: your latest rows are held, and a panel is always there', async () => {
  const { holdLastRows, buildClipJob } = await import('../src/main/studio/render');
  const rows = [
    { slot: 0, from: 1.9, to: 3.6, x0: 0.38 },
    { slot: 1, from: 3.6, to: 6.1, x0: 0.38 },
    { slot: 0, from: 3.9, to: 6.4, x0: 0.3 },
  ];
  const held = holdLastRows(rows, 9);
  assert.equal(held[0].to, 3.6, 'a row pushed down by a newer one is not held');
  assert.deepEqual([held[1].to, held[2].to], [9, 9], 'the last rows stay until the clip ends');
  const slid = holdLastRows([{ slot: 0, from: 1, to: 2.1, x0: 0.4 }, { slot: 1, from: 2.3, to: 4, x0: 0.4 }], 6);
  assert.ok(Math.abs(slid[0].to - 2.37) < 1e-9, 'a row sliding down stays in its old slot until just before it has settled in the next');
  assert.equal(slid[1].from, 2.4);
  const clip = { uid: 'p', clipId: 'p', videoFile: 'x.mp4', durationSec: 5, width: 1920, height: 1080, fps: 60, hasMic: false, hits: [2], in: 0, out: 5, useMic: false, cropX: .5, cropY: .5, cropZoom: 1, kills: 1, score: 1, tags: [], feedRows: [] };
  const job = buildClipJob({ clip, audioCount: 0, segments: [{ clipUid: 'p', clipIndex: 0, kind: 'lead', src: [0.5, 2.5], out: [0, 2], speed: 1 }], size: { width: 1080, height: 1080 }, fps: 30, style: getStyle('raw'), preview: true, workDir: os.tmpdir() });
  assert.match(job.filter, /geq=r='0':g='0':b='0':a='128\*between/, 'panel drawn even before any row of yours');
  assert.doesNotMatch(job.filter, /enable='/, 'and nothing switches on or off');
});

test('song start and end times in a prompt are read, and not taken as the reel length', async () => {
  const { readIntent } = await import('../src/main/studio/intent');
  const a = readIntent('make it 20 seconds and start the song at 0:56');
  assert.deepEqual([a.seconds, a.songStart, a.songEnd], [20, 56, undefined]);
  const b = readIntent('20s reel, end the song at 1:12.5 where the hey hey hey part ends');
  assert.deepEqual([b.seconds, b.songStart, b.songEnd], [20, undefined, 72.5]);
  const c = readIntent('song from 48 seconds');
  assert.deepEqual([c.seconds, c.songStart], [undefined, 48]);
});

test('a held feed row keeps its own picture after the game replaces it', { skip: !available }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-held-row-'));
  try {
    const source = path.join(dir, 's.mp4');
    // A white "own" row in slot 0 until 1 s, then an orange "teammate" row in the same place.
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=0x3070c0:s=1000x500:r=30:d=3', '-vf', "drawbox=x=800:y=14:w=180:h=12:c=white:t=fill:enable='lt(t,1)',drawbox=x=800:y=14:w=180:h=12:c=orange:t=fill:enable='gte(t,1)'", '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
    const clip = { uid: 'h', clipId: 'h', videoFile: source, durationSec: 3, width: 1000, height: 500, fps: 30, hasMic: false, hits: [0.3], in: 0, out: 3, useMic: false, cropX: .5, cropY: .5, cropZoom: 1, kills: 1, score: 1, tags: [],
      feedRows: [{ slot: 0, from: 0.2, to: 0.9, x0: 0.15 }] };
    const size = { width: 320, height: 320 };
    const job = buildClipJob({ clip, audioCount: 0, segments: [{ clipUid: 'h', clipIndex: 0, kind: 'lead', src: [0.1, 2.5], out: [0, 2.4], speed: 1 }], size, fps: 30, style: getStyle('raw'), preview: true, workDir: dir });
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-filter_complex', job.filter, ...job.args]);
    const rgb = execFileSync(ffmpeg, ['-v', 'error', '-ss', '1.8', '-i', job.output, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    const box = feedBox(size);
    const fx = (900 - (1000 - 500 * 0.49)) / (500 * 0.454), fy = (20 - 12.5) / 55;
    const i = (Math.round(box.y + fy * box.height) * 320 + Math.round(box.x + fx * box.width)) * 3;
    const px = [...rgb.subarray(i, i + 3)];
    assert.ok(px.every((v) => v > 200), `held row still shows your white row, not the teammate's: ${px}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
