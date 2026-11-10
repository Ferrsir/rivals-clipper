import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { StreakTracker } from '../src/main/streak';
import { DEFAULT_SETTINGS } from '../src/main/settings';
import { MatchState, isPracticeMode, parseMaybeJson } from '../src/main/match-state';

// Exercise the real Electron event handlers without launching Electron or the game.
function harness() {
  let now = 100000;
  let active = false;
  const timers: Array<{ fn: () => void; due: number; cancelled: boolean }> = [];
  const starts: Array<{ file: string; cb: (video: any) => void }> = [];
  const saved: any[] = [];
  const state = new MatchState();
  const recorder = {
    info: { width: 320, height: 180, fps: 30, micRecorded: false },
    async startClip(file: string, _past: number, cb: (v: any) => void) {
      if (active) return;
      active = true; starts.push({ file, cb });
    },
    stopClip() { active = false; },
  };
  const ctx = vm.createContext({ recorder, state, settings: { ...DEFAULT_SETTINGS },
    quitting: false, pending: undefined, stopTimer: undefined,
    streak: new StreakTracker({ preRollMs: 12000, postRollMs: 5000, maxClipMs: 90000 }),
    Date: class extends Date { static now() { return now; } }, path,
    lateBy: (at: number, n: number) => Math.max(0, n - at), clipFileName: () => `clip-${now}`,
    setTimeout: (fn: () => void, ms: number) => { const t = { fn, due: now + ms, cancelled: false }; timers.push(t); return t; },
    clearTimeout: (t: typeof timers[number]) => { t.cancelled = true; },
    isPracticeMode, parseMaybeJson, log: { write() {} }, status() {}, writeSidecar: (c: any) => { saved.push(c); return { ...c, score: 0 }; },
    matchClips: [], pushClip() {}, tagger: { enqueue() {}, kick() {} }, inMatch: false,
    fs, paths: () => ({ heroRoles: path.join(require('node:os').tmpdir(), 'rc-test-hero-roles.json') }), sidecarPath: (f: string) => f, updateSidecar: () => undefined,
  });
  const source = fs.readFileSync(path.join(__dirname, '../../src/main/main.ts'), 'utf8');
  const code = source.slice(source.indexOf('async function beginClip'), source.indexOf('function setupGep'));
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  const advance = (to: number) => {
    now = to;
    for (const t of timers) if (!t.cancelled && t.due <= now) { t.cancelled = true; t.fn(); }
  };
  const complete = (i: number) => starts[i].cb({ filePath: `${starts[i].file}.mp4`, duration: 17000, startTimeEpoch: 88000 });
  return { ctx, starts, saved, advance, complete };
}

test('new kills record while a previous mux saves; out-of-order callbacks keep ownership', async () => {
  const h = harness();
  h.ctx.handleKill(100000); await Promise.resolve();
  h.advance(105000);
  assert.equal(h.ctx.pending, undefined);
  h.advance(105100); h.ctx.handleKill(105100); await Promise.resolve();
  assert.equal(h.starts.length, 2);
  const second = h.ctx.pending;
  h.complete(0);
  assert.equal(h.ctx.pending, second, 'old save cannot clear new capture or its timer');
  assert.equal(h.saved[0].events.length, 1);
  h.advance(110100); h.complete(1);
  assert.equal(h.saved[1].events.length, 1);
  assert.equal(h.saved[1].events[0].at, 105100);
});

test('manual capture retains trigger and receives kills and assists without phantom kills', async () => {
  const h = harness();
  h.ctx.handleManualClip(); await Promise.resolve();
  h.advance(100500); h.ctx.handleKill(100500);
  h.ctx.onGameEvent('screen', 'assist', {}, 101000);
  h.advance(101100);
  assert.equal(h.starts.length, 1);
  assert.equal(h.ctx.pending.trigger, 'manual');
  assert.equal(h.ctx.pending.events.filter((e: any) => e.type === 'kill').length, 1);
  assert.equal(h.ctx.pending.events.filter((e: any) => e.type === 'assist').length, 1);
  h.ctx.stopCapture(); h.complete(0);
  assert.equal(h.saved[0].trigger, 'manual');
});

test('reverse save completion preserves each clip and its original match and dimensions', async () => {
  const h = harness();
  h.ctx.state.context.map = 'Original map';
  h.ctx.handleKill(100000); await Promise.resolve(); h.ctx.stopCapture();
  h.ctx.state.onMatchStart(); h.ctx.state.context.map = 'Next map';
  h.ctx.recorder.info.width = 640;
  h.advance(106000); h.ctx.handleKill(106000); await Promise.resolve(); h.ctx.stopCapture();
  h.complete(1); h.complete(0);
  assert.equal(h.saved[0].match.map, 'Next map');
  assert.equal(h.saved[1].match.map, 'Original map');
  assert.equal(h.saved[0].video.width, 640);
  assert.equal(h.saved[1].video.width, 320);
  assert.equal(h.ctx.matchClips.length, 1);
});

test('late kill enrichment cannot migrate an event into a later clip', async () => {
  const h = harness();
  h.ctx.handleKill(100000); await Promise.resolve();
  h.ctx.stopCapture(); h.complete(0);
  h.advance(100100); h.ctx.handleManualClip(); await Promise.resolve();
  h.advance(100500);
  assert.equal(h.ctx.pending.events.length, 0);
  assert.equal(h.saved[0].events.length, 1);
});

test('failed old startup cannot clear a newer clip', async () => {
  const h = harness();
  let reject!: (err: Error) => void;
  const original = h.ctx.recorder.startClip;
  h.ctx.recorder.startClip = () => new Promise((_resolve, r) => { reject = r; });
  h.ctx.handleManualClip();
  h.ctx.stopCapture();
  h.ctx.recorder.startClip = original;
  h.ctx.handleKill(100000); await Promise.resolve();
  const current = h.ctx.pending;
  reject(new Error('old start failed')); await Promise.resolve();
  assert.equal(h.ctx.pending, current);
});

test('an assist starts a clip on its own', async () => {
  const h = harness();
  h.ctx.onGameEvent('screen', 'assist', { victim: 'Mokka' }, 100000); await Promise.resolve();
  assert.equal(h.starts.length, 1);
  assert.equal(JSON.stringify(h.ctx.pending.events.map((e: any) => [e.type, e.victim])), JSON.stringify([['assist', 'Mokka']]));
});

test('Overwolf: kills while you are dead or spectating do not clip', async () => {
  const h = harness();
  h.ctx.state.onInfoUpdate('match_info', 'roster_0', { name: 'Me', is_local: true, is_alive: false }, 99000);
  h.ctx.state.onInfoUpdate('match_info', 'roster_1', { name: 'Mate', is_local: false, is_alive: true }, 99000);
  h.ctx.onGameEvent('gep', 'death', 1, 95000);
  h.ctx.onGameEvent('gep', 'kill', 1, 100000); await Promise.resolve();
  assert.equal(h.starts.length, 0);
  // A KO right as you die still counts.
  h.ctx.onGameEvent('gep', 'death', 2, 100500);
  h.ctx.onGameEvent('gep', 'kill', 2, 101000); await Promise.resolve();
  assert.equal(h.starts.length, 1);
});

test('Overwolf: a roster with nobody marked as you is spectating', () => {
  const s = new MatchState();
  s.onInfoUpdate('match_info', 'roster_0', { name: 'A', is_local: false }, 0);
  s.onInfoUpdate('match_info', 'roster_1', { name: 'B', is_local: false }, 0);
  assert.equal(s.notPlaying(1000), 'spectating');
  s.onInfoUpdate('match_info', 'roster_2', { name: 'Me', is_local: true, is_alive: true }, 0);
  assert.equal(s.notPlaying(1000), undefined);
});

test('a misread hero name is stored as the real hero, and junk keeps the last good one', () => {
  const s = new MatchState();
  s.onInfoUpdate('game_info', 'local_hero', 'CBSBEADPOOL', 0);
  assert.equal(s.myHero, 'Deadpool');
  s.onInfoUpdate('game_info', 'local_hero', 'R CAA', 0);
  assert.equal(s.myHero, 'Deadpool');
});

test('a new match forgets the last hero, and a clip takes the hero recognised while it records', async () => {
  const h = harness();
  h.ctx.state.onInfoUpdate('game_info', 'local_hero', 'Deadpool', 0);
  h.ctx.onGameEvent('screen', 'match_start', undefined, 99000);
  assert.equal(h.ctx.state.myHero, undefined);
  h.ctx.handleKill(100000); await Promise.resolve();
  h.ctx.onInfoUpdate('game_info', 'local_hero', 'Magik');
  assert.equal(h.ctx.pending.hero, 'Magik');
});
