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
    lastDeathAt: -Infinity, hudGoneAt: undefined, engine: 'overwolf',
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
  // Clips join the match's list once their death-screen check is done.
  await new Promise((r) => setImmediate(r));
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

test('match_start keeps the hero, and a clip takes the hero recognised while it records', async () => {
  const h = harness();
  h.ctx.state.onInfoUpdate('game_info', 'local_hero', 'Deadpool', 0);
  // 2026-11-10 04:34: match_start fired again mid-match and the clips came out "Unknown hero".
  h.ctx.onGameEvent('screen', 'match_start', undefined, 99000);
  assert.equal(h.ctx.state.myHero, 'Deadpool');
  h.ctx.handleKill(100000); await Promise.resolve();
  assert.equal(h.ctx.pending.hero, 'Deadpool');
  h.ctx.onInfoUpdate('game_info', 'local_hero', 'Magik');
  assert.equal(h.ctx.pending.hero, 'Magik');
});

// 2026-11-09 22:33 (0.2.7): a double at 3.3 s and 4.5 s, then the death; the clip ran 4 s on into the
// death screen. Now the death ends it a second later.
test('your death ends an auto clip a second after it', async () => {
  const h = harness();
  const stops: Array<number | undefined> = [];
  h.ctx.recorder.stopClip = (until?: number) => stops.push(until);
  h.ctx.handleKill(100000); await Promise.resolve();
  h.ctx.handleKill(101200);
  h.ctx.onGameEvent('screen', 'death', 1, 101700);
  h.advance(101800);
  assert.ok(h.ctx.pending, 'still waits briefly for a late report of a kill made just before the death');
  h.advance(106300);
  assert.equal(h.ctx.pending, undefined);
  assert.deepEqual(stops, [102700]);
});

test('a manual clip is not cut by a death', async () => {
  const h = harness();
  h.ctx.handleManualClip(); await Promise.resolve();
  const stopAt = h.ctx.streak.currentStopAt;
  h.ctx.onGameEvent('screen', 'death', 1, 100500);
  assert.equal(h.ctx.streak.currentStopAt, stopAt);
});

// 2026-11-09 18:42: two kills in the last second of a round, then the clip ran on into "CONTROL KRAKOA".
test('a clip ends where the match bar went away after its last kill', async () => {
  const h = harness();
  const stops: Array<number | undefined> = [];
  h.ctx.recorder.stopClip = (until?: number) => stops.push(until);
  h.ctx.handleKill(100000); await Promise.resolve();
  h.ctx.handleKill(100500);
  h.ctx.onGameEvent('screen', 'hud', false, 102000);
  h.advance(130000);
  assert.deepEqual(stops, [102300]);
});

test('the match bar coming back leaves the clip end alone', async () => {
  const h = harness();
  const stops: Array<number | undefined> = [];
  h.ctx.recorder.stopClip = (until?: number) => stops.push(until);
  h.ctx.handleKill(100000); await Promise.resolve();
  h.ctx.onGameEvent('screen', 'hud', false, 101000);
  h.ctx.onGameEvent('screen', 'hud', true, 101500);
  h.advance(130000);
  assert.deepEqual(stops, [105000]);
});

test('a round change ends the clip even when the match bar is back before the clip stops', async () => {
  const h = harness();
  const stops: Array<number | undefined> = [];
  h.ctx.recorder.stopClip = (until?: number) => stops.push(until);
  h.ctx.handleKill(100000); await Promise.resolve();
  h.ctx.onGameEvent('screen', 'hud', false, 102000);
  h.ctx.onGameEvent('screen', 'hud', true, 108000);
  h.advance(130000);
  assert.deepEqual(stops, [102300]);
});

test('a match bar lost long before the kills does not shorten the clip', async () => {
  const h = harness();
  const stops: Array<number | undefined> = [];
  h.ctx.recorder.stopClip = (until?: number) => stops.push(until);
  h.ctx.onGameEvent('screen', 'hud', false, 80000);
  h.ctx.handleKill(100000); await Promise.resolve();
  h.advance(130000);
  assert.deepEqual(stops, [105000]);
});
