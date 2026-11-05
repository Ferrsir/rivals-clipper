import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LocalRecorder } from '../src/main/capture/local-recorder';
import { DEFAULT_SETTINGS } from '../src/main/settings';

const fixture = fs.readFileSync(path.join(__dirname, '../../test/fixtures/gop10.mpegts'));

for (const failure of ['close', 'exit-before-close', 'signal-before-close', 'error'] as const) {
  test(`startup rejects buffered video from a dead process (${failure}) and can retry`, async t => {
    let attempt = 0;
    let interruptions = 0;
    const rec = new LocalRecorder(() => {}, {
      ffmpeg: async () => 'synthetic-capture',
      probe: async () => ({ ok: true, width: 640, height: 360, encoder: { id: 'x264', gpuFrames: false }, adapters: [], tried: [] }),
      audioHelperPath: () => undefined,
      onInterrupted: () => interruptions++,
      spawnVideo: () => {
        const events = new EventEmitter();
        const child = Object.assign(events, {
          stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
          exitCode: null as number | null, signalCode: null as string | null,
          kill() { this.exitCode = 0; queueMicrotask(() => events.emit('close', 0)); return true; },
        });
        const fail = ++attempt === 1;
        queueMicrotask(() => {
          child.stdout.write(fixture);
          if (!fail) return;
          if (failure === 'signal-before-close') child.signalCode = 'SIGTERM';
          else child.exitCode = 1;
          if (failure === 'error') events.emit('error', new Error('capture failed'));
          if (failure === 'close') events.emit('close', 1);
          else setImmediate(() => events.emit('close', 1));
        });
        return child as unknown as ChildProcessWithoutNullStreams;
      },
    });
    t.after(() => rec.stop());
    await assert.rejects(rec.start(DEFAULT_SETTINGS, {}, '.'), /ffmpeg exited/);
    assert.equal(rec.info, undefined, 'failed capture must never become healthy');
    assert.equal(interruptions, 0, 'startup rejection owns retry instead of a duplicate interruption');
    const info = await rec.start(DEFAULT_SETTINGS, {}, '.');
    assert.equal(info.width, 640);
    assert.equal(attempt, 2);
  });
}
