import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Updater, busyReason, compareVersions, installerCommand, isInside, pickInstaller, type Release, type UpdateState } from '../src/main/updater';

const bytes = Buffer.from('fake installer bytes');
const sha = createHash('sha256').update(bytes).digest('hex');

function release(version: string, digest: string | null = `sha256:${sha}`): Release {
  return {
    tag_name: `v${version}`,
    body: 'notes',
    assets: [
      { name: 'latest.yml', size: 10, browser_download_url: 'https://x/latest.yml' },
      { name: `RivalsClipper-Setup-${version}.exe`, size: bytes.length, browser_download_url: 'https://x/setup.exe', digest },
    ],
  };
}

function fakeFetch(rel: Release | 404, file = bytes) {
  return async (url: string) => {
    if (url.includes('api.github.com')) {
      if (rel === 404) return { ok: false, status: 404, json: async () => ({}), body: null, headers: { get: () => null } };
      return { ok: true, status: 200, json: async () => rel, body: null, headers: { get: () => null } };
    }
    return { ok: true, status: 200, json: async () => ({}), body: new Blob([file]).stream(), headers: { get: () => String(file.length) } };
  };
}

function setup(opts: { rel: Release | 404; file?: Buffer; busy?: { gameRunning: boolean; clipping: boolean }; library?: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-update-'));
  const spawned: string[][] = [];
  const states: UpdateState[] = [];
  let quits = 0;
  const busy = opts.busy ?? { gameRunning: false, clipping: false };
  const u = new Updater({
    currentVersion: '0.2.9',
    downloadDir: dir,
    installDir: 'F:\\New folder\\Rivals Clipper',
    libraryFolder: () => opts.library ?? 'F:\\RivalsClips',
    busy: () => busy,
    quit: () => { quits++; },
    onChange: (s) => states.push(s),
    pid: 4242,
    platform: 'win32',
    packaged: true,
    fetch: fakeFetch(opts.rel, opts.file) as never,
    spawn: (cmd, args) => { spawned.push([cmd, ...args]); },
  });
  return { u, dir, spawned, states, busy, quits: () => quits };
}

test('versions compare by number, not text', () => {
  assert.ok(compareVersions('0.2.10', '0.2.9') > 0);
  assert.ok(compareVersions('v0.3.0', '0.2.9') > 0);
  assert.equal(compareVersions('0.2.9', 'v0.2.9'), 0);
  assert.ok(compareVersions('0.2.8', '0.2.9') < 0);
});

test('picks the Setup exe, not latest.yml or blockmaps', () => {
  assert.equal(pickInstaller(release('0.3.0'))?.name, 'RivalsClipper-Setup-0.3.0.exe');
  assert.equal(pickInstaller({ tag_name: 'v1', assets: [{ name: 'RivalsClipper-Setup-0.3.0.exe.blockmap', size: 1, browser_download_url: '' }] }), undefined);
});

test('a library inside the app folder is caught, a sibling folder is not', () => {
  assert.ok(isInside('F:\\New folder\\Rivals Clipper\\clips', 'F:\\New folder\\Rivals Clipper'));
  assert.ok(isInside('f:\\new folder\\rivals clipper', 'F:\\New folder\\Rivals Clipper'));
  assert.ok(!isInside('F:\\RivalsClips', 'F:\\New folder\\Rivals Clipper'));
  assert.ok(!isInside('F:\\New folder\\Rivals Clipper 2', 'F:\\New folder\\Rivals Clipper'));
});

test('busy while the game is open or a clip is saving', () => {
  assert.equal(busyReason({ gameRunning: false, clipping: false }), undefined);
  assert.match(busyReason({ gameRunning: true, clipping: false })!, /recording/);
  assert.match(busyReason({ gameRunning: false, clipping: true })!, /saved/);
});

test('installer command waits for this app to exit, then runs silently and reopens', () => {
  const cmd = installerCommand(4242, "C:\\Users\\o'neil\\AppData\\Local\\Temp\\rivals-clipper-update\\RivalsClipper-Setup-0.3.0.exe");
  assert.match(cmd, /^Wait-Process -Id 4242 /);
  assert.ok(cmd.includes("'C:\\Users\\o''neil\\"));
  assert.ok(cmd.includes("'/S','--updated','--force-run'"));
});

test('check reports up to date, a newer release, or no releases', async () => {
  assert.equal((await setup({ rel: release('0.2.9') }).u.check()).phase, 'up-to-date');
  const s = await setup({ rel: release('0.3.0') }).u.check();
  assert.equal(s.phase, 'available');
  assert.equal(s.latest, '0.3.0');
  const none = await setup({ rel: 404 }).u.check();
  assert.equal(none.phase, 'up-to-date');
  assert.match(none.message!, /No releases/);
});

test('install downloads, checks the checksum, starts the installer and quits', async () => {
  const t = setup({ rel: release('0.3.0') });
  await t.u.check();
  const s = await t.u.install();
  assert.equal(s.phase, 'installing');
  assert.equal(t.quits(), 1);
  assert.equal(t.spawned.length, 1);
  assert.equal(t.spawned[0][0], 'powershell.exe');
  const file = path.join(t.dir, 'RivalsClipper-Setup-0.3.0.exe');
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.ok(t.spawned[0].at(-1)!.includes(file));
  assert.ok(t.states.some((x) => x.phase === 'downloading'));
});

test('a download that does not match the checksum is thrown away', async () => {
  const t = setup({ rel: release('0.3.0', `sha256:${'0'.repeat(64)}`) });
  const s = await t.u.install();
  assert.equal(s.phase, 'error');
  assert.match(s.message!, /checksum/);
  assert.equal(t.spawned.length, 0);
  assert.equal(t.quits(), 0);
  assert.deepEqual(fs.readdirSync(t.dir), []);
});

test('while recording, the install waits and runs once the game closes', async () => {
  const t = setup({ rel: release('0.3.0'), busy: { gameRunning: true, clipping: false } });
  const s = await t.u.install();
  assert.equal(s.phase, 'waiting');
  assert.equal(t.spawned.length, 0);
  t.u.idle(); // still recording
  assert.equal(t.spawned.length, 0);
  t.busy.gameRunning = false;
  t.u.idle();
  assert.equal(t.spawned.length, 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(t.quits(), 1);
});

test('a waiting install can be called off', async () => {
  const t = setup({ rel: release('0.3.0'), busy: { gameRunning: true, clipping: false } });
  await t.u.install();
  assert.equal(t.u.cancel().phase, 'ready');
  t.busy.gameRunning = false;
  t.u.idle();
  assert.equal(t.spawned.length, 0);
});

test('refuses when the clips folder is inside the app folder', async () => {
  const t = setup({ rel: release('0.3.0'), library: 'F:\\New folder\\Rivals Clipper\\RivalsClips' });
  const s = await t.u.install();
  assert.equal(s.phase, 'error');
  assert.match(s.message!, /inside the app folder/);
  assert.equal(t.spawned.length, 0);
});

test('an install waiting on the game runs when the app closes instead of being lost', async () => {
  const t = setup({ rel: release('0.3.0'), busy: { gameRunning: true, clipping: false } });
  assert.equal((await t.u.install()).phase, 'waiting');
  assert.equal(t.spawned.length, 0);
  // The flag that held it was stale (or the game closed first): the app closing installs it.
  t.busy.gameRunning = false;
  assert.equal(t.u.onQuit(), true);
  assert.equal(t.spawned.length, 1);
  assert.equal(t.quits(), 0, 'already quitting: does not ask to quit again');
  assert.equal(t.u.onQuit(), false, 'only once');
  // Nothing queued: closing the app installs nothing.
  const idle = setup({ rel: release('0.3.0') });
  assert.equal(idle.u.onQuit(), false);
});

test('"Install now anyway" skips the wait when the app wrongly thinks the game is open', async () => {
  const t = setup({ rel: release('0.3.0'), busy: { gameRunning: true, clipping: false } });
  assert.equal((await t.u.install()).phase, 'waiting');
  assert.equal((await t.u.install(true)).phase, 'installing');
  assert.equal(t.spawned.length, 1);
  assert.equal(t.quits(), 1);
  // The app then closes: the install that was queued must not start a second time.
  assert.equal(t.u.onQuit(), false);
  t.busy.gameRunning = false;
  t.u.idle();
  assert.equal(t.spawned.length, 1);
});

test('"Install now anyway" still waits for a clip that is being saved', async () => {
  const t = setup({ rel: release('0.3.0'), busy: { gameRunning: true, clipping: true } });
  assert.equal((await t.u.install(true)).phase, 'waiting');
  assert.equal(t.spawned.length, 0);
});

test('closing the app during a Windows shutdown or mid-game keeps the update for later', async () => {
  const t = setup({ rel: release('0.3.0'), busy: { gameRunning: false, clipping: true } });
  assert.equal((await t.u.install()).phase, 'waiting');
  t.busy.clipping = false;
  assert.equal(t.u.onQuit({ sessionEnding: true }), false);
  t.busy.gameRunning = true;
  assert.equal(t.u.onQuit(), false);
  t.busy.gameRunning = false;
  assert.equal(t.u.onQuit(), true);
  assert.equal(t.spawned.length, 1);
});

test('the app does not quit when the installer could not be started', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-update-'));
  let quits = 0;
  const u = new Updater({
    currentVersion: '0.2.9', downloadDir: dir, installDir: 'F:\\App', libraryFolder: () => 'F:\\RivalsClips',
    busy: () => ({ gameRunning: false, clipping: false }), quit: () => { quits++; }, onChange: () => {}, pid: 1, platform: 'win32', packaged: true,
    fetch: fakeFetch(release('0.3.0')) as never, spawn: async () => { throw new Error('spawn powershell.exe ENOENT'); },
  });
  const s = await u.install();
  assert.equal(s.phase, 'error');
  assert.match(s.message!, /ENOENT/);
  assert.equal(quits, 0);
});

test('a newer release replaces a queued install instead of leaving it stuck', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-update-'));
  let rel = release('0.3.0');
  const lines: string[] = [];
  const busy = { gameRunning: true, clipping: false };
  const u = new Updater({
    currentVersion: '0.2.9', downloadDir: dir, installDir: 'F:\\App', libraryFolder: () => 'F:\\RivalsClips',
    busy: () => busy, quit: () => {}, onChange: () => {}, pid: 1, platform: 'win32', packaged: true,
    fetch: (async (url: string) => fakeFetch(rel)(url)) as never, spawn: () => {}, log: (l) => lines.push(l),
  });
  assert.equal((await u.install()).phase, 'waiting');
  rel = release('0.3.1');
  const s = await u.check();
  assert.equal(s.phase, 'available');
  assert.equal(s.latest, '0.3.1');
  busy.gameRunning = false;
  assert.equal(u.onQuit(), false, 'the old queued install is dropped');
  busy.gameRunning = true;
  assert.equal((await u.install()).phase, 'waiting');
  busy.gameRunning = false;
  assert.ok(u.onQuit());
  await new Promise((r) => setImmediate(r));
  assert.ok(lines.some((l) => l.startsWith('waiting 0.3.1')), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('started installer')));
});
