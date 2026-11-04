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
