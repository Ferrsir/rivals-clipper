import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalRecorder } from '../src/main/capture/local-recorder';
import { DEFAULT_SETTINGS } from '../src/main/settings';
import { clipFileName } from '../src/main/clip-store';
import type { SavedVideo } from '../src/main/capture/types';

const fixture = fs.readFileSync(path.join(__dirname, '../../test/fixtures/gop10.mpegts'));
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
let hasFfmpeg = true;
try { execFileSync(ffmpeg, ['-version'], { stdio: 'ignore', windowsHide: true }); } catch { hasFfmpeg = false; }

async function recorder(t: TestContext, bin = ffmpeg, badFolder = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivals-save-test-'));
  const folder = badFolder ? path.join(root, 'file-instead-of-folder') : root;
  if (badFolder) fs.writeFileSync(folder, 'original');
  const messages: string[] = [];
  const events = new EventEmitter();
  const child = Object.assign(events, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, kill() { this.exitCode = 0; setImmediate(() => events.emit('close', 0)); return true; } });
  const rec = new LocalRecorder(msg => messages.push(msg), {
    ffmpeg: async () => bin,
    probe: async () => ({ ok: true, width: 640, height: 360, encoder: { id: 'x264', gpuFrames: false }, adapters: [], tried: [] }),
    audioHelperPath: () => undefined,
    spawnVideo: () => { queueMicrotask(() => child.stdout.write(fixture)); return child as unknown as ChildProcessWithoutNullStreams; },
  });
  t.after(async () => { await rec.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await rec.start({ ...DEFAULT_SETTINGS, recordMic: false }, {}, folder);
  return { rec, root, folder, messages };
}

test('stop waits for a real synthetic-video mux and one completion callback', { skip: !hasFfmpeg }, async t => {
  const { rec, root } = await recorder(t);
  const results: SavedVideo[] = [];
  await rec.startClip('saved', 2000, video => results.push(video));
  await Promise.all([rec.stop(), rec.stop()]);
  assert.equal(results.length, 1);
  assert.equal(results[0].error, undefined);
  assert.ok(fs.existsSync(path.join(root, 'saved.mp4')));
  execFileSync(ffmpeg, ['-v', 'error', '-i', path.join(root, 'saved.mp4'), '-f', 'null', '-'], { stdio: 'pipe', windowsHide: true });
  assert.deepEqual(fs.readdirSync(path.join(root, '.recording')), []);
  await assert.rejects(rec.startClip('after-stop', 1000, () => {}), /not running/);
});

test('failed conversion retains the raw replay in a recovery folder', async t => {
  const { rec, root } = await recorder(t, path.join(os.tmpdir(), 'missing-rivals-ffmpeg.exe'));
  const results: SavedVideo[] = [];
  await rec.startClip('recoverable', 2000, video => results.push(video));
  await rec.stop();
  assert.equal(results.length, 1);
  assert.ok(results[0].error);
  assert.ok(results[0].recoveryFolder);
  assert.ok(fs.statSync(path.join(results[0].recoveryFolder!, 'recoverable.ts')).size > 0);
  assert.equal(fs.existsSync(path.join(root, 'recoverable.mp4')), false);
});

test('unwritable clip path reports failure once and does not reject stop', async t => {
  const { rec, folder } = await recorder(t, ffmpeg, true);
  const results: SavedVideo[] = [];
  await rec.startClip('bad-path', 2000, video => results.push(video));
  await rec.stop();
  assert.equal(results.length, 1);
  assert.ok(results[0].error);
  assert.equal(fs.readFileSync(folder, 'utf8'), 'original');
});

test('a failing sidecar callback cannot erase a saved video or run twice', { skip: !hasFfmpeg }, async t => {
  const { rec, root, messages } = await recorder(t);
  let calls = 0;
  await rec.startClip('callback-failure', 2000, () => { calls++; throw new Error('sidecar write failed'); });
  await rec.stop();
  assert.equal(calls, 1);
  assert.ok(fs.existsSync(path.join(root, 'callback-failure.mp4')));
  assert.ok(messages.some(msg => msg.includes('saved video is at')));
});

test('saving refuses to replace an existing clip and retains recovery input', { skip: !hasFfmpeg }, async t => {
  const { rec, root } = await recorder(t);
  const target = path.join(root, 'existing.mp4');
  fs.writeFileSync(target, 'original');
  const results: SavedVideo[] = [];
  await rec.startClip('existing', 2000, video => results.push(video));
  await rec.stop();
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  assert.ok(results[0].recoveryFolder);
  assert.match(String(results[0].error), /refusing to replace/);
});

test('clips triggered at exactly the same timestamp get different filenames', () => {
  const now = new Date('2026-11-04T12:00:00.000Z');
  assert.notEqual(clipFileName(now, 0, 'Magik'), clipFileName(now, 0, 'Magik'));
});
