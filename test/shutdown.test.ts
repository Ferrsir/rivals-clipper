import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installGracefulShutdown } from '../src/main/shutdown';

function fakeApp() {
  const app = Object.assign(new EventEmitter(), { exits: 0, quit() {
    let prevented = false;
    app.emit('before-quit', { preventDefault: () => { prevented = true; } });
    if (!prevented) app.exits++;
  } });
  return app;
}

test('repeated quit requests wait for one clip-save cleanup before the app exits', async () => {
  const app = fakeApp();
  let finish!: () => void;
  let cleanups = 0;
  const saved = new Promise<void>(resolve => { finish = resolve; });
  installGracefulShutdown(app, async () => { cleanups++; await saved; }, () => assert.fail('cleanup failed'));
  app.quit();
  app.quit();
  assert.equal(app.exits, 0);
  assert.equal(cleanups, 1);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.exits, 1);
  assert.equal(cleanups, 1);
});

test('shutdown reports cleanup errors and still permits the final quit', async () => {
  const app = fakeApp();
  const errors: unknown[] = [];
  installGracefulShutdown(app, async () => { throw new Error('disk unavailable'); }, error => errors.push(error));
  app.quit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.exits, 1);
  assert.equal(errors.length, 1);
});
