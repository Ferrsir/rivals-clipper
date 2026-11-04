import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MusicAnalysis, ReelClip } from '../src/shared/studio';
import { orderClips, placeCaptions, plan } from '../src/main/studio/planner';
import { getStyle, sanitizeStyle } from '../src/main/studio/styles';

function grid(bpm: number, seconds: number, dropBar: number, offset = 0.5): MusicAnalysis {
  const p = 60 / bpm;
  const beats: number[] = [];
  for (let t = offset; t < seconds; t += p) beats.push(Math.round(t * 1000) / 1000);
  const downbeats = beats.filter((_, i) => i % 4 === 0);
  return {
    version: 1,
    durationSec: seconds,
    bpm,
    beats,
    downbeats,
    beatEnergy: beats.map((_, i) => (i >= dropBar * 4 ? 1 : 0.3)),
    drops: [downbeats[dropBar]],
    energy: 0.8,
    confidence: 0.9,
    peaks: [],
  };
}

function clip(uid: string, hits: number[], score: number, duration = 18): ReelClip {
  return {
    uid,
    clipId: uid,
    videoFile: `/clips/${uid}.mp4`,
    kills: hits.length,
    score,
    tags: [],
    durationSec: duration,
    width: 2560,
    height: 1440,
    fps: 60,
    hasMic: true,
    hits,
    in: 0,
    out: duration,
    useMic: false,
    cropX: 0.5,
    cropY: 0.5,
    cropZoom: 1,
  };
}

const fps = 60;
const near = (t: number, list: number[]) => Math.min(...list.map((b) => Math.abs(b - t)));

function checkTimeline(tl: ReturnType<typeof plan>, clips: ReelClip[], speedRange: [number, number]) {
  // Segments are contiguous, frame-aligned and inside their clips.
  let t = 0;
  for (const s of tl.segments) {
    assert.ok(Math.abs(s.out[0] - t) < 1e-6, `gap before ${s.kind} at ${s.out[0]} (expected ${t})`);
    assert.ok(Math.abs(s.out[0] * fps - Math.round(s.out[0] * fps)) < 1e-3, 'not on frame grid');
    assert.ok(s.out[1] > s.out[0]);
    t = s.out[1];
    if (s.kind === 'intro') continue;
    const c = clips[s.clipIndex];
    assert.ok(s.src[0] >= c.in - 1e-6 && s.src[1] <= c.out + 1e-6, `segment outside clip: ${s.src}`);
    // Output length matches source length / speed.
    assert.ok(Math.abs((s.src[1] - s.src[0]) / s.speed - (s.out[1] - s.out[0])) < 1e-3);
    if (s.kind === 'lead' || s.kind === 'gap' || s.kind === 'tail') {
      assert.ok(s.speed >= speedRange[0] - 0.06 && s.speed <= speedRange[1] + 0.06, `${s.kind} speed ${s.speed} outside ${speedRange}`);
    }
  }
  assert.ok(Math.abs(t - tl.duration) < 1e-6);
}

test('velocity: every kill and every cut lands on a beat', () => {
  const an = grid(140, 90, 12);
  const style = getStyle('velocity');
  const clips = [clip('a', [12.1], 20), clip('b', [12.4, 13.9, 15.2], 90), clip('c', [11.8, 14.6], 50)];
  const tl = plan({ clips, style, fps, analysis: an, musicStart: 'auto' });
  checkTimeline(tl, clips, style.speedRange);
  assert.equal(tl.kills.length, 6);
  for (const k of tl.kills) assert.ok(near(k, tl.beats) <= 1 / fps + 1e-6, `kill at ${k} is ${near(k, tl.beats)} s off the beat`);
  for (const c of tl.cuts) assert.ok(near(c, tl.beats) <= 1 / fps + 1e-6, `cut at ${c} off beat`);
  assert.deepEqual(tl.warnings.filter((w) => w.includes('beat')), []);
});

test('the best clip\'s first kill lands on the drop', () => {
  const an = grid(128, 120, 16);
  const style = getStyle('velocity');
  const clips = [clip('a', [12.1], 20), clip('b', [12.0, 13.1], 40), clip('best', [12.3, 13.0, 14.1, 15.5], 200), clip('d', [12.5], 30)];
  const tl = plan({ clips, style, fps, analysis: an, musicStart: 'auto' });
  checkTimeline(tl, clips, style.speedRange);
  assert.ok(tl.drop !== undefined, 'drop inside the reel');
  const heroKill = tl.clips[2].kills[0];
  assert.ok(Math.abs(heroKill - tl.drop!) <= 1 / fps + 1e-6, `hero kill ${heroKill} vs drop ${tl.drop}`);
});

test('with an intro card, the cut into gameplay lands on the drop', () => {
  const an = grid(110, 120, 6);
  const style = getStyle('story');
  const clips = [clip('a', [12.1, 13.5], 40), clip('b', [12.2], 30)];
  const tl = plan({ clips, style, fps, analysis: an, musicStart: 'auto', intro: { text: 'hook', seconds: 5 } });
  checkTimeline(tl, clips, style.speedRange);
  assert.equal(tl.segments[0].kind, 'intro');
  assert.ok(tl.drop !== undefined && Math.abs(tl.introEnd - tl.drop) <= 1 / fps, `intro ends ${tl.introEnd}, drop ${tl.drop}`);
  assert.ok(tl.introEnd > 2.5 && tl.introEnd < 7.6);
});

test('a fixed music start is respected', () => {
  const an = grid(140, 90, 12);
  const tl = plan({ clips: [clip('a', [12], 10)], style: getStyle('beat-cuts'), fps, analysis: an, musicStart: 10 });
  assert.equal(tl.musicStart, 10);
});

test('raw style without music keeps real time and the whole kill window', () => {
  const style = getStyle('raw');
  const clips = [clip('a', [12.0, 14.0], 10), clip('b', [], 5, 8)];
  const tl = plan({ clips, style, fps, analysis: null });
  checkTimeline(tl, clips, [1, 1]);
  for (const s of tl.segments) assert.ok(Math.abs(s.speed - 1) < 0.01, `speed ${s.speed}`);
  // Lead-in = leadIn max (5 s) before the first kill.
  assert.ok(Math.abs(tl.kills[0] - 5) < 0.02, `first kill at ${tl.kills[0]}`);
  // Clip without kills is used whole.
  const b = tl.clips[1];
  assert.ok(Math.abs(b.out[1] - b.out[0] - 8) < 0.02);
  assert.ok(tl.warnings.some((w) => w.includes('no kill marked')));
});

test('slow-mo is applied around kills', () => {
  const an = grid(140, 90, 12);
  const style = getStyle('velocity');
  const tl = plan({ clips: [clip('a', [12.0], 10)], style, fps, analysis: an });
  const slow = tl.segments.filter((s) => s.kind === 'slow-in' || s.kind === 'slow-out');
  assert.equal(slow.length, 2);
  for (const s of slow) assert.ok(Math.abs(s.speed - style.slowmo.speed) < 0.05, `slow speed ${s.speed}`);
});

test('kills too close for full slow-mo still produce a valid timeline', () => {
  const an = grid(150, 90, 12);
  const style = getStyle('velocity');
  const clips = [clip('a', [12.0, 12.3, 12.55, 15], 10)];
  const tl = plan({ clips, style, fps, analysis: an });
  checkTimeline(tl, clips, [0.15, 3]);
  assert.equal(tl.kills.length, 4);
});

test('warns when the song is shorter than the reel', () => {
  const an = grid(140, 12, 2);
  const clips = [clip('a', [12], 10), clip('b', [12], 10), clip('c', [12], 10), clip('d', [12], 10)];
  const tl = plan({ clips, style: getStyle('velocity'), fps, analysis: an });
  assert.ok(tl.musicShort);
  assert.ok(tl.warnings.some((w) => w.includes('song ends')));
});

test('captions spread over the beat grid', () => {
  const beats = Array.from({ length: 40 }, (_, i) => i * 0.5);
  const caps = placeCaptions([{ text: 'one' }, { text: 'two' }, { text: ' ' }, { text: 'three', start: 9, end: 10 }], beats, 20, 4);
  assert.deepEqual(caps, [
    { text: 'one', start: 0, end: 2 },
    { text: 'two', start: 2, end: 4 },
    { text: 'three', start: 9, end: 10 },
  ]);
});

test('build-up order puts the best clip last', () => {
  const c = [clip('a', [12], 90), clip('b', [12], 10), clip('c', [12], 50)];
  assert.deepEqual(orderClips(c, 'build-up').map((x) => x.uid), ['b', 'c', 'a']);
});

test('sanitizeStyle clamps hostile values', () => {
  const s = sanitizeStyle({ speedRange: [0, 99], slowmo: { speed: -1 }, shake: { amount: 5 }, transition: 'explode', captions: { size: 9 } }, getStyle('velocity'));
  assert.deepEqual(s.speedRange, [0.25, 4]);
  assert.equal(s.slowmo.speed, 0.15);
  assert.equal(s.shake.amount, 0.04);
  assert.equal(s.transition, 'flash');
  assert.equal(s.captions.size, 0.12);
});

test('cinematic dip transition with a single clip builds a valid eq expression', async () => {
  const { effectsChain } = await import('../src/main/studio/render');
  const style = getStyle('cinematic');
  style.transition = 'dip';
  const tl = plan({ clips: [clip('a', [8], 50)], style, fps: 60, analysis: grid(120, 60, 4) });
  assert.equal(tl.cuts.length, 0);
  const chain = effectsChain({ timeline: tl, style, size: { width: 1080, height: 1920 }, fps: 60, preview: false });
  const eq = chain.find((f) => f.startsWith('eq='));
  assert.ok(eq);
  assert.ok(!/\(\)|,\)/.test(eq), eq);
});

test('each export gets its own base name, even within the same minute', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { uniqueExportBase } = await import('../src/main/studio/pipeline');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reels-'));
  const at = new Date(2026, 10, 4, 12, 30);
  const first = uniqueExportBase(dir, 'My Reel', at);
  fs.writeFileSync(path.join(dir, `${first}_tiktok.mp4`), '');
  fs.writeFileSync(path.join(dir, `${first}_shorts.mp4`), '');
  const second = uniqueExportBase(dir, 'My Reel', at);
  assert.notEqual(second, first);
  assert.equal(second, `${first}-2`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('with a hook card, story captions wait for the gameplay', () => {
  const an = grid(128, 90, 4);
  const style = getStyle('story');
  const clips = [clip('a', [9], 10), clip('b', [9, 10], 40), clip('c', [8, 9, 10], 90)];
  const tl = plan({ clips, style, fps: 60, analysis: an, musicStart: 'auto', intro: { text: 'Hook', seconds: 5 }, captions: [{ text: 'one' }, { text: 'two' }] });
  assert.ok(tl.introEnd > 0);
  assert.equal(tl.captions.length, 2);
  assert.ok(tl.captions[0].start >= tl.introEnd - 1e-3, `caption at ${tl.captions[0].start}, intro ends ${tl.introEnd}`);
});

test('hook lines share the hook card in turn, under the picture band', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { hookTimes, introBand, textFilters } = await import('../src/main/studio/render');
  const { FORMATS } = await import('../src/main/studio/formats');
  assert.deepEqual(hookTimes(3, 4.5), [[0, 1.5], [1.5, 3], [3, 4.5]]);
  assert.deepEqual(hookTimes(0, 4), []);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-'));
  const size = { width: 1080, height: 1920 };
  const timeline = { introEnd: 4.5, duration: 30, captions: [{ text: 'story', start: 5, end: 7 }] } as any;
  const f = textFilters({ timeline, style: getStyle('story'), format: FORMATS.tiktok, size, workDir, fontFile: '/fonts/x.ttf', intro: { text: "Who's stronger?\nHim?\nOr you?", seconds: 4.5, layout: 'band' }, outro: { text: 'Comment who wins', seconds: 3 } });
  assert.equal(f.length, 5); // 3 hook lines, 1 caption, 1 end text
  assert.equal(fs.readFileSync(path.join(workDir, 'cap1.txt'), 'utf8'), 'HIM?');
  const band = introBand(size);
  const y = Number(/:y=(\d+):/.exec(f[0])![1]);
  assert.ok(y > size.height * (band.center + band.height / 2), `hook text at ${y} should sit under the band`);
  assert.match(f[1], /between\(t,1\.5,3\)/);
  assert.match(f[4], /between\(t,27,30\)/);
  assert.equal(fs.readFileSync(path.join(workDir, 'cap4.txt'), 'utf8').replace(/\n/g, ' '), 'COMMENT WHO WINS');
});

test('hook text fits under the picture on landscape exports too', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { textFilters } = await import('../src/main/studio/render');
  const { FORMATS } = await import('../src/main/studio/formats');
  for (const [fmt, size] of [[FORMATS.youtube, { width: 1920, height: 1080 }], [FORMATS.youtube1440, { width: 2560, height: 1440 }], [FORMATS.tiktok, { width: 1080, height: 1920 }]] as const) {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hookfit-'));
    const timeline = { introEnd: 3, duration: 20, captions: [] } as any;
    const [f] = textFilters({ timeline, style: getStyle('story'), format: fmt, size, workDir, fontFile: '/fonts/x.ttf', intro: { text: 'POV: you main Deadpool and nobody believes you', seconds: 3, layout: 'band' } });
    const y = Number(/:y=(\d+):/.exec(f)![1]);
    const fontsize = Number(/:fontsize=(\d+):/.exec(f)![1]);
    const lines = fs.readFileSync(path.join(workDir, 'cap0.txt'), 'utf8').split('\n').length;
    const bottom = y + lines * fontsize * 1.18;
    assert.ok(bottom <= size.height * (1 - fmt.safe.bottom) + 1, `${fmt.id}: text ends at ${Math.round(bottom)} of ${size.height}`);
  }
});
