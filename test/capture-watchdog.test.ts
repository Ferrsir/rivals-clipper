import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureWatchdog } from '../src/main/capture/watchdog';

test('a live process with no encoded output triggers recovery exactly once', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0;
  let recoveries = 0;
  const watch = new CaptureWatchdog(() => recoveries++, () => now);
  watch.start();
  now = 14_999;
  t.mock.timers.tick(2000);
  assert.equal(recoveries, 0);
  now = 15_000;
  t.mock.timers.tick(2000);
  assert.equal(recoveries, 1);
  now = 100_000;
  t.mock.timers.tick(60_000);
  assert.equal(recoveries, 1);
});

test('continued encoded output keeps the capture alive through a long session', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0;
  let recoveries = 0;
  const watch = new CaptureWatchdog(() => recoveries++, () => now);
  watch.start();
  for (let i = 0; i < 3600; i++) {
    now += 1000;
    watch.progress();
    t.mock.timers.tick(1000);
  }
  assert.equal(recoveries, 0);
  watch.stop();
});

test('stop cancels monitoring and starting again gets a fresh grace period', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0;
  let recoveries = 0;
  const watch = new CaptureWatchdog(() => recoveries++, () => now);
  watch.start();
  watch.stop();
  now = 60_000;
  t.mock.timers.tick(60_000);
  assert.equal(recoveries, 0);
  watch.start();
  now += 14_000;
  t.mock.timers.tick(2000);
  assert.equal(recoveries, 0);
  now += 2000;
  t.mock.timers.tick(2000);
  assert.equal(recoveries, 1);
});
