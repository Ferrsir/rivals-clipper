import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreakTracker } from '../src/main/streak';

const cfg = { preRollMs: 12_000, postRollMs: 5_000, maxClipMs: 90_000 };

test('first kill starts a clip with pre-roll', () => {
  const s = new StreakTracker(cfg);
  const a = s.onKill(100_000);
  assert.deepEqual(a, { type: 'start', pastDurationMs: 12_000, stopAt: 105_000 });
  assert.equal(s.isActive, true);
});

test('kills inside the window extend the same clip', () => {
  const s = new StreakTracker(cfg);
  s.onKill(100_000);
  assert.deepEqual(s.onKill(103_000), { type: 'extend', stopAt: 108_000 });
  assert.deepEqual(s.onKill(107_500), { type: 'extend', stopAt: 112_500 });
});

test('clip length is capped', () => {
  const s = new StreakTracker({ ...cfg, maxClipMs: 20_000 });
  s.onKill(100_000); // clip footage starts at 88_000, cap at 108_000
  assert.deepEqual(s.onKill(104_000), { type: 'extend', stopAt: 108_000 });
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
  assert.deepEqual(first,{type:'start',pastDurationMs:3000,stopAt:104000});
  assert.deepEqual(tracker.onKill(101300),{type:'extend',stopAt:105300});
  assert.deepEqual(tracker.onKill(104028),{type:'extend',stopAt:108028});
});
