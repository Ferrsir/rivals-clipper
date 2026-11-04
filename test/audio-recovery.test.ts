import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AudioCapture } from '../src/main/capture/audio-helper';
import { encodeChunk } from '../src/main/capture/audio-buffer';
import { GameWatcher } from '../src/main/capture/game-watcher';
import { ScreenDetector } from '../src/main/vision/screen-detector';
import { DEFAULT_SETTINGS } from '../src/main/settings';

function fakeHelper() {
  const events = new EventEmitter();
  const proc = Object.assign(events, {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null,
    kill() { this.close(0); return true; },
    close(code: number) { this.exitCode = code; events.emit('close', code); },
  });
  proc.stdin.on('finish', () => proc.close(0));
  return proc;
}

function setup() {
  const children: ReturnType<typeof fakeHelper>[] = [];
  const commands: string[][] = [];
  const audio = new AudioCapture('helper', 5000, (_bin, args) => {
    const child = fakeHelper();
    children.push(child);
    commands.push(args);
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  return { audio, children, commands };
}

test('audio helper recovers with the same source and preserves buffered sound', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { audio, children, commands } = setup();
  audio.start({ gamePid: 42, mic: 'my-mic', bufferMs: 5000 });
  const pcm = Buffer.alloc(480 * 4, 7);
  const chunk = encodeChunk({ track: 0, sampleRate: 48000, channels: 2, epochMs: 1000, pcm });
  children[0].stdout.write(chunk);
  // A half-written message at the crash must not poison the restarted process's parser.
  children[0].stdout.write(chunk.subarray(0, 17));
  children[0].close(1);
  assert.equal(audio.running, false);
  t.mock.timers.tick(1999);
  assert.equal(children.length, 1);
  t.mock.timers.tick(1);
  assert.equal(children.length, 2);
  assert.deepEqual(commands[1], commands[0]);
  assert.ok(commands[1].includes('42') && commands[1].includes('my-mic'));
  children[1].stdout.write(encodeChunk({ track: 0, sampleRate: 48000, channels: 2, epochMs: 1020, pcm }));
  assert.deepEqual(audio.game.extract(1000, 1010), pcm);
  assert.deepEqual(audio.game.extract(1020, 1030), pcm);
  assert.equal(audio.running, true);
  await audio.stop();
});

test('stopping during audio recovery cancels every pending retry and clears old audio', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { audio, children } = setup();
  audio.start({ desktopAudio: true, bufferMs: 5000 });
  children[0].stdout.write(encodeChunk({ track: 0, sampleRate: 48000, channels: 2, epochMs: 1000, pcm: Buffer.alloc(1920, 1) }));
  children[0].close(1);
  await audio.stop();
  t.mock.timers.tick(120_000);
  assert.equal(children.length, 1);
  assert.equal(audio.game.endEpoch, 0);
  assert.equal(audio.running, false);
});

test('repeated helper crashes back off and stop after five retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { audio, children } = setup();
  const messages: string[] = [];
  audio.on('status', msg => messages.push(msg));
  audio.start({ desktopAudio: true, bufferMs: 5000 });
  for (const delay of [2000, 4000, 8000, 16000, 30000]) {
    const before = children.length;
    children.at(-1)!.close(1);
    t.mock.timers.tick(delay - 1);
    assert.equal(children.length, before);
    t.mock.timers.tick(1);
    assert.equal(children.length, before + 1);
  }
  children.at(-1)!.close(1);
  t.mock.timers.tick(120_000);
  assert.equal(children.length, 6);
  assert.ok(messages.some(msg => msg.includes('could not recover')));
  await audio.stop();
});

test('failed helper spawn is handled and can recover', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { audio, children } = setup();
  audio.start({ desktopAudio: true, bufferMs: 5000 });
  children[0].emit('error', new Error('temporary launch failure'));
  children[0].close(-1);
  t.mock.timers.tick(2000);
  assert.equal(children.length, 2);
  await audio.stop();
});

test('a delayed process query cannot launch capture after the game watcher stops', () => {
  let answer!: (err: Error | null, stdout: string) => void;
  const watcher = new GameWatcher(3000, 'Marvel-Win64-Shipping.exe', done => { answer = done; });
  let launches = 0;
  watcher.on('launched', () => launches++);
  watcher.start();
  watcher.stop();
  answer(null, '"Marvel-Win64-Shipping.exe","42","Console"');
  assert.equal(launches, 0);
  assert.equal(watcher.game, undefined);
});

test('an immediate stop cancels screen detection before ffmpeg lookup', async () => {
  let lookups = 0;
  const detector = new ScreenDetector({ ffmpeg: async () => { lookups++; return 'missing'; },
    dataDir: () => 'unused', log: () => {}, sink: { gameEvent: () => {}, infoUpdate: () => {} } });
  const starting = detector.start(DEFAULT_SETTINGS);
  await detector.stop();
  await starting;
  assert.equal(lookups, 0);
  assert.equal(detector.running, false);
});
