import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreakTracker } from '../src/main/streak';

const cfg = { preRollMs: 12_000, postRollMs: 5_000, maxClipMs: 90_000 };

test('first kill starts a clip with pre-roll', () => {
  const s = new StreakTracker(cfg);
  const a = s.onKill(100_000);
  assert.deepEqual(a, { type: 'start', pastDurationMs: 12_000, stopAt: 105_000, endAt: 105_000 });
  assert.equal(s.isActive, true);
});

test('kills inside the window extend the same clip', () => {
  const s = new StreakTracker(cfg);
  s.onKill(100_000);
  assert.deepEqual(s.onKill(103_000), { type: 'extend', stopAt: 108_000, endAt: 108_000 });
  assert.deepEqual(s.onKill(107_500), { type: 'extend', stopAt: 112_500, endAt: 112_500 });
});

test('clip length is capped', () => {
  const s = new StreakTracker({ ...cfg, maxClipMs: 20_000 });
  s.onKill(100_000); // clip footage starts at 88_000, cap at 108_000
  assert.deepEqual(s.onKill(104_000), { type: 'extend', stopAt: 108_000, endAt: 108_000 });
  assert.deepEqual(s.onKill(107_000), { type: 'none' });
});

test('after finish, the next kill starts a new clip', () => {
  const s = new StreakTracker(cfg);
  s.onKill(100_000);
  s.finish();
  assert.equal(s.onKill(200_000).type, 'start');
});

test('a triple with 1.3 and 2.728 second gaps stays in one highlight', () => {
  const tracker = new StreakTracker({preRollMs:3000,postRollMs:4000,maxClipMs:20000});
  const first = tracker.onKill(100000);
  assert.deepEqual(first,{type:'start',pastDurationMs:3000,stopAt:104000,endAt:104000});
  assert.deepEqual(tracker.onKill(101300),{type:'extend',stopAt:105300,endAt:105300});
  assert.deepEqual(tracker.onKill(104028),{type:'extend',stopAt:108028,endAt:108028});
});

// Ferris, 2026-11-09 13:41: kills at :02.658, :05.840 (reported 1.6 s late) and :12.088 became three
// 1-kill clips. The game called it a triple. Same settings as his install: 3 s pre, 4 s post, 20 s cap.
test('a triple with a late-reported kill and a 6.2 s gap stays in one clip, trimmed to the last kill', () => {
  const s = new StreakTracker({ preRollMs: 3000, postRollMs: 4000, maxClipMs: 20000, chainMs: 8000, lateMs: 2500 });
  const a = s.onKill(2658);
  assert.equal(a.type, 'start');
  // Still waiting when the second kill is finally reported at 7.473 s.
  assert.ok(s.currentStopAt > 7473);
  assert.deepEqual(s.onKill(5840), { type: 'extend', stopAt: 16340, endAt: 9840 });
  // Third kill is reported at 12.504 s, well inside the wait.
  assert.ok(s.currentStopAt > 12504);
  assert.deepEqual(s.onKill(12088), { type: 'extend', stopAt: 22588, endAt: 16088 });
  // Footage ends 4 s after the last kill, not at the end of the wait.
  assert.equal(s.currentEndAt, 16088);
});

test('kills farther apart than the chain window get separate clips', () => {
  const s = new StreakTracker({ preRollMs: 3000, postRollMs: 4000, maxClipMs: 20000, chainMs: 8000, lateMs: 2500 });
  s.onKill(0);
  assert.equal(s.currentStopAt, 10500);
});

test('a kill past the length cap starts a new clip instead of a marker past the footage', () => {
  const s = new StreakTracker({ preRollMs: 3000, postRollMs: 4000, maxClipMs: 20000, chainMs: 8000, lateMs: 2500 });
  s.onKill(100000); // footage from 97000, cap 117000
  assert.deepEqual(s.onKill(107000), { type: 'extend', stopAt: 117500, endAt: 111000 });
  assert.deepEqual(s.onKill(114000), { type: 'extend', stopAt: 117500, endAt: 117000 });
  assert.deepEqual(s.onKill(117300), { type: 'restart' });
});

// 2026-11-09 18:33, a penta the game called out: kills 13.2, 6.2, 13.7 and 7.5 s apart, saved as five 1-kill clips.
test('a penta with 13+ second gaps is one clip with the default settings', () => {
  const s = new StreakTracker({ preRollMs: 3000, postRollMs: 4000, maxClipMs: 60000, chainMs: 15000, lateMs: 2500 });
  const kills = [781896, 795140, 801341, 814999, 822529];
  assert.equal(s.onKill(kills[0]).type, 'start');
  for (const k of kills.slice(1)) {
    assert.ok(k < s.currentStopAt, `still recording at ${k}`);
    assert.equal(s.onKill(k).type, 'extend');
  }
  assert.equal(s.currentEndAt, 822529 + 4000);
});

test('a multi-kill callout keeps the clip open for another full window', () => {
  const s = new StreakTracker({ preRollMs: 3000, postRollMs: 4000, maxClipMs: 60000, chainMs: 15000, lateMs: 2500 });
  s.onKill(100000);
  assert.equal(s.hold(110000), 127500);
  assert.equal(s.currentEndAt, 104000, 'the callout itself adds no footage');
  assert.equal(new StreakTracker({ preRollMs: 3000, postRollMs: 4000, maxClipMs: 60000 }).hold(1), undefined);
});
