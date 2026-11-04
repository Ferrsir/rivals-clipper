// No audio source is opened: omitted/zero game PIDs must be rejected rather than selecting desktop audio.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const helper = path.resolve(__dirname, '../native/bin/rc-audio.exe');
for (const args of [['capture'], ['capture', '--game-pid', '0']]) {
  const result = spawnSync(helper, args, { input: '', encoding: 'utf8', timeout: 8000, windowsHide: true });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.match(result.stderr, /no valid game process was supplied; desktop sound will not be recorded/);
  assert.equal(result.stdout, '', 'invalid source must produce no captured audio');
  assert.doesNotMatch(result.stderr, /"event":"started"/);
}
console.log('Native audio policy verified: no implicit desktop capture for absent/invalid game PID.');
