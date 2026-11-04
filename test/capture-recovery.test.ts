import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureRecovery } from '../src/main/capture/recovery';

test('unavailable screen capture backs off, keeps retrying, and can recover later', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const recovery = new CaptureRecovery();
  let tries = 0;
  for (const expected of [2000, 4000, 8000, 16000, 30000, 30000, 30000]) {
    assert.equal(recovery.schedule(() => tries++), expected);
    const before = tries;
    t.mock.timers.tick(expected - 1);
    assert.equal(tries, before);
    t.mock.timers.tick(1);
    assert.equal(tries, before + 1);
  }
  recovery.reset();
  assert.equal(recovery.schedule(() => tries++), 2000, 'successful recovery resets backoff');
  recovery.reset();
});

test('game exit or app shutdown cancels a pending recording restart', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const recovery = new CaptureRecovery();
  let tries = 0;
  recovery.schedule(() => tries++);
  recovery.reset();
  t.mock.timers.tick(120_000);
  assert.equal(tries, 0);
});

test('manual recording restart supersedes pending work without overlapping retries', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const recovery = new CaptureRecovery();
  const calls: string[] = [];
  recovery.schedule(() => calls.push('old'));
  recovery.clearPending();
  recovery.schedule(() => calls.push('new'));
  t.mock.timers.tick(120_000);
  assert.deepEqual(calls, ['new']);
  recovery.reset();
});
