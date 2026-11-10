import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LocalRecorder } from '../src/main/capture/local-recorder';
import { recordArgs } from '../src/main/capture/encoder';
import { DEFAULT_SETTINGS } from '../src/main/settings';

const fixture = fs.readFileSync(path.join(__dirname, '../../test/fixtures/gop10.mpegts'));

function setup(windowSize: () => { width: number; height: number } | undefined) {
  const resized: Array<{ width: number; height: number }> = [];
  const logs: string[] = [];
  let child: (EventEmitter & { stderr: PassThrough }) | undefined;
  const rec = new LocalRecorder((m) => logs.push(m), {
    ffmpeg: async () => 'synthetic-capture',
    probe: async () => ({ ok: true, width: 1920, height: 1080, encoder: { id: 'x264', gpuFrames: false }, adapters: [], tried: [] }),
    probeSize: async () => windowSize(),
    resizeSettleMs: 20,
    audioHelperPath: () => undefined,
    onResized: (s) => resized.push(s),
    spawnVideo: () => {
      const events = new EventEmitter();
      const c = Object.assign(events, {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        exitCode: null as number | null, signalCode: null as string | null,
        kill() { this.exitCode = 0; queueMicrotask(() => events.emit('close', 0)); return true; },
      });
      queueMicrotask(() => c.stdout.write(fixture));
      child = c;
      return c as unknown as ChildProcessWithoutNullStreams;
    },
  });
  const say = (line: string) => child!.stderr.write(line + '\n');
  return { rec, resized, logs, say };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('switching to stretched 4:3 mid-game asks for a restart at the new size, once it settles', async (t) => {
  let size = { width: 1920, height: 1080 };
  const { rec, resized, say } = setup(() => size);
  t.after(() => rec.stop());
  await rec.start(DEFAULT_SETTINGS, {}, '.');
  // A resolution switch passes through a few sizes; only the final one counts.
  say('[Parsed_gfxcapture_0 @ 000001] [verbose] Capture size changed to 1280x720');
  await wait(5);
  size = { width: 1440, height: 1080 };
  say('[Parsed_gfxcapture_0 @ 000001] [verbose] Capture size changed to 1440x1080');
  await wait(80);
  assert.deepEqual(resized, [{ width: 1440, height: 1080 }]);
});

test('a size report that ends at the recorded size, or a minimised game, does not restart anything', async (t) => {
  let size: { width: number; height: number } | undefined = { width: 1920, height: 1080 };
  const { rec, resized, say } = setup(() => size);
  t.after(() => rec.stop());
  await rec.start(DEFAULT_SETTINGS, {}, '.');
  say('[Parsed_gfxcapture_0 @ 000001] [verbose] Capture size changed to 1920x1080');
  await wait(80);
  size = { width: 160, height: 28 };
  say('[Parsed_gfxcapture_0 @ 000001] [verbose] Capture size changed to 160x28');
  await wait(80);
  assert.deepEqual(resized, []);
});

test('verbose ffmpeg lines stay out of the error text, warnings stay in', () => {
  const args = recordArgs({ outputIdx: 0, fps: 60, bitrateKbps: 8000, encoder: { id: 'x264', gpuFrames: false } });
  assert.equal(args[args.indexOf('-loglevel') + 1], 'level+verbose');
  assert.ok(args.includes('-nostats'));
});
