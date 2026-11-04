import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AudioChunkParser, PcmRing, encodeChunk, wavHeader } from '../src/main/capture/audio-buffer';
import { TS_PACKET, TsReplayBuffer } from '../src/main/capture/ts-buffer';
import { encoderCandidates, muxArgs, parseAdapterLine, parseVideoSize, recordArgs, videoFilter, type GpuAdapter } from '../src/main/capture/encoder';
import { parseTasklist, GameWatcher } from '../src/main/capture/game-watcher';
import { chooseEngine, lateBy } from '../src/main/engine';
import { localOptions } from '../src/main/settings';

// 4 s of 10 fps H.264 in MPEG-TS, a keyframe every second (made with ffmpeg, see test name).
const FIXTURE = fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'gop10.mpegts'));

// ---------- replay buffer ----------

test('ts buffer splits real ffmpeg output into one-second GOPs', () => {
  const b = new TsReplayBuffer({ maxMs: 60_000, frameTicks: 9000 });
  const now = 1_000_000;
  b.push(FIXTURE, now);
  assert.equal(b.ready, true);
  assert.equal(Math.round(b.durationMs), 4000);
  // The clock is sampled at keyframes. Everything arrived at `now`, so the newest keyframe maps to now
  // and the ones before it to 1, 2 and 3 seconds earlier.
  const h = b.beginCapture(60_000, now);
  const all = b.endCapture(h)!;
  assert.equal(all.frames, 40);
  assert.equal(Math.round(all.startEpoch), now - 3000);
  assert.equal(Math.round(all.endEpoch), now + 1000);
});

test('ts buffer starts a clip on the keyframe before the requested pre-roll', () => {
  const b = new TsReplayBuffer({ maxMs: 60_000, frameTicks: 9000 });
  const now = 1_000_000;
  b.push(FIXTURE, now);
  // 1.5 s back is inside the second GOP (it starts 2 s back).
  const r = b.endCapture(b.beginCapture(1500, now))!;
  assert.equal(r.frames, 30);
  assert.equal(Math.round(r.startEpoch), now - 2000);
  // The clip is a valid TS on its own: PAT first, and it parses back into 3 GOPs.
  assert.equal(r.data[0], 0x47);
  assert.equal(r.data.length % TS_PACKET, 0);
  const again = new TsReplayBuffer({ maxMs: 60_000, frameTicks: 9000 });
  again.push(r.data, now);
  assert.equal(Math.round(again.durationMs), 3000);
});

test('ts buffer copes with packets split across pushes', () => {
  const b = new TsReplayBuffer({ maxMs: 60_000, frameTicks: 9000 });
  for (let off = 0; off < FIXTURE.length; off += 1000) b.push(FIXTURE.subarray(off, off + 1000), 1_000_000);
  const r = b.endCapture(b.beginCapture(60_000, 1_000_000))!;
  assert.equal(r.frames, 40);
});

test('ts buffer only keeps about maxMs of video', () => {
  const b = new TsReplayBuffer({ maxMs: 1500, frameTicks: 9000 });
  b.push(FIXTURE, 1_000_000);
  // Whole GOPs: enough to cover the window, at most one GOP more.
  assert.ok(b.durationMs <= 1500 + 2000, `held ${b.durationMs} ms`);
  assert.ok(b.durationMs >= 1500);
});

test('ts buffer end time cuts whole GOPs that start after it', () => {
  const b = new TsReplayBuffer({ maxMs: 60_000, frameTicks: 9000 });
  const now = 1_000_000;
  b.push(FIXTURE, now);
  // GOPs start at now-3000, -2000, -1000 and now: ending at now-1500 keeps the first two.
  const r = b.endCapture(b.beginCapture(60_000, now), now - 1500)!;
  assert.equal(r.frames, 20);
});

// ---------- audio ----------

const FMT = { sampleRate: 48000, channels: 2 };

test('pcm ring extracts a wall-clock window and fills gaps with silence', () => {
  const ring = new PcmRing(FMT, 10_000);
  const tenMs = Buffer.alloc(480 * 4, 1); // 10 ms of non-zero samples
  ring.push(1000, tenMs);
  ring.push(1020, tenMs); // 10 ms gap before this one
  const out = ring.extract(1000, 1030);
  assert.equal(out.length, 1440 * 4);
  assert.equal(out[0], 1);
  assert.equal(out[480 * 4 + 8], 0); // inside the gap
  assert.equal(out[960 * 4 + 8], 1);
  assert.equal(Math.round(ring.endEpoch), 1030);
});

test('pcm ring drops audio older than its window', () => {
  const ring = new PcmRing(FMT, 50);
  for (let t = 0; t < 200; t += 10) ring.push(t, Buffer.alloc(480 * 4, 2));
  const out = ring.extract(0, 100);
  assert.equal(out[0], 0); // evicted
});

test('audio chunk parser reads the helper format across split reads and resyncs after junk', () => {
  const a = encodeChunk({ track: 0, channels: 2, sampleRate: 48000, epochMs: 123.5, pcm: Buffer.alloc(400, 7) });
  const b = encodeChunk({ track: 1, channels: 1, sampleRate: 48000, epochMs: 130, pcm: Buffer.alloc(200, 9) });
  const stream = Buffer.concat([Buffer.from('junk'), a, b]);
  const p = new AudioChunkParser();
  const got: Array<{ track: number; epochMs: number; len: number }> = [];
  for (let i = 0; i < stream.length; i += 37) p.push(stream.subarray(i, i + 37), (c) => got.push({ track: c.track, epochMs: c.epochMs, len: c.pcm.length }));
  assert.deepEqual(got, [
    { track: 0, epochMs: 123.5, len: 400 },
    { track: 1, epochMs: 130, len: 200 },
  ]);
});

test('wav header describes 16-bit PCM', () => {
  const h = wavHeader(1000, FMT);
  assert.equal(h.toString('ascii', 0, 4), 'RIFF');
  assert.equal(h.readUInt32LE(40), 1000);
  assert.equal(h.readUInt32LE(24), 48000);
});

// ---------- encoder choice ----------

const NVIDIA: GpuAdapter = { index: 0, vendorId: '10de', deviceId: '2c02', name: 'NVIDIA GeForce RTX 5080', vendor: 'nvidia' };
const AMD: GpuAdapter = { index: 1, vendorId: '1002', deviceId: '13c0', name: 'AMD Radeon(TM) Graphics', vendor: 'amd' };

test('adapter line and video size are read from ffmpeg output', () => {
  assert.deepEqual(parseAdapterLine('[AVHWDeviceContext @ 0x1] Using device 10de:2c02 (NVIDIA GeForce RTX 5080).', 0), NVIDIA);
  assert.deepEqual(parseVideoSize('Stream #0:1: Audio: aac\n  Stream #0:0: Video: h264 (High), yuv420p, 2560x1440 [SAR 1:1], 60 fps'), { width: 2560, height: 1440 });
});

test('monitor on the GeForce: NVENC with GPU frames first', () => {
  const c = encoderCandidates([NVIDIA, AMD]);
  assert.deepEqual(c[0], { id: 'nvenc', gpuFrames: true });
  assert.equal(c[c.length - 1].id, 'x264');
});

test('monitor on the motherboard (AMD iGPU): AMF on the iGPU first, NVENC by copy as a fallback', () => {
  const c = encoderCandidates([AMD, NVIDIA]);
  assert.deepEqual(c[0], { id: 'amf', gpuFrames: true });
  assert.ok(c.some((e) => e.id === 'nvenc' && !e.gpuFrames));
});

test('record command keeps 1 s keyframes, no B-frames and no audio', () => {
  const args = recordArgs({ outputIdx: 0, fps: 60, bitrateKbps: 30000, encoder: { id: 'nvenc', gpuFrames: true } });
  const at = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(at('-c:v'), 'h264_nvenc');
  assert.equal(at('-g'), '60');
  assert.equal(at('-bf'), '0');
  assert.ok(args.includes('-an'));
  assert.equal(videoFilter({ outputIdx: 0, fps: 60, bitrateKbps: 1, encoder: { id: 'nvenc', gpuFrames: true } }), undefined);
  assert.match(videoFilter({ outputIdx: 0, fps: 60, bitrateKbps: 1, encoder: { id: 'x264', gpuFrames: false }, scaleHeight: 1080, height: 1440 })!, /hwdownload.*scale=-2:1080/);
});

test('mux puts game audio on track 1 and mic on track 2', () => {
  const args = muxArgs('v.ts', [{ file: 'g.wav', label: 'game' }, { file: 'm.wav', label: 'mic' }], 'out.mp4');
  const maps = args.filter((_, i) => args[i - 1] === '-map');
  assert.deepEqual(maps, ['0:v:0', '1:a:0', '2:a:0']);
  assert.ok(args.includes('title=Game') && args.includes('title=Mic'));
  assert.equal(args[args.length - 1], 'out.mp4');
});

// ---------- game watcher ----------

test('tasklist parsing finds the game process', () => {
  const csv = '"Marvel.exe","1200","Console","1","10,000 K"\r\n"Marvel-Win64-Shipping.exe","4321","Console","1","3,000,000 K"\r\n';
  assert.deepEqual(parseTasklist(csv), { pid: 4321, name: 'Marvel-Win64-Shipping.exe' });
  assert.equal(parseTasklist('INFO: No tasks are running which match the specified criteria.'), undefined);
});

test('game watcher reports launch and exit once each', () => {
  const w = new GameWatcher();
  const seen: string[] = [];
  w.on('launched', (g) => seen.push(`up ${g.pid}`));
  w.on('exit', () => seen.push('down'));
  w.update({ pid: 5, name: 'x' });
  w.update({ pid: 5, name: 'x' });
  w.update(undefined);
  w.update(undefined);
  w.update({ pid: 6, name: 'x' });
  assert.deepEqual(seen, ['up 5', 'down', 'up 6']);
});

// ---------- engine choice ----------

test('auto engine: Overwolf when it loads, local when it cannot', () => {
  assert.equal(chooseEngine('auto', { present: true, ready: true, failed: false }), 'overwolf');
  assert.equal(chooseEngine('auto', { present: true, ready: false, failed: false }), undefined);
  assert.equal(chooseEngine('auto', { present: true, ready: false, failed: true }), 'local');
  assert.equal(chooseEngine('auto', { present: false, ready: false, failed: false }), 'local');
  assert.equal(chooseEngine('local', { present: true, ready: true, failed: false }), 'local');
  assert.equal(chooseEngine('overwolf', { present: true, ready: false, failed: true }), 'overwolf');
  assert.equal(chooseEngine('overwolf', { present: false, ready: false, failed: false }), 'local');
});

test('late screen events stretch the pre-roll by how late they are', () => {
  assert.equal(lateBy(1000, 2200), 1200);
  assert.equal(lateBy(2200, 1000), 0);
  assert.equal(lateBy(0, 100_000), 0); // nonsense timestamps are ignored
});

test('local settings are cleaned up', () => {
  const o = localOptions({ hudScale: 'abc' as unknown as number, captureMonitor: -3, detectionFps: 99, localEncoder: 'foo' as never, engine: 'local', playerName: '  Leithl  ' });
  assert.deepEqual(o, { engine: 'local', captureMonitor: 0, localEncoder: 'auto', playerName: 'Leithl', hudScale: 1, detectionFps: 20, readScreenText: true });
});
