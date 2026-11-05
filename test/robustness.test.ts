import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS, loadSettings, sanitizeSettings, saveSettings, writeFileAtomic } from '../src/main/settings';
import { isClipFile } from '../src/main/clip-store';

test('settings from a bad form or hand-edited file are made valid', () => {
  const s = sanitizeSettings({
    preRollSeconds: '',
    postRollSeconds: 999,
    bufferSeconds: 5,
    fps: '120',
    resolution: '8k',
    gameAudio: 'desktop',
    recordMic: 'yes',
    aiProvider: 'gemini',
    rootFolder: '   ',
    somethingElse: 1,
  });
  assert.equal(s.preRollSeconds, DEFAULT_SETTINGS.preRollSeconds);
  assert.equal(s.postRollSeconds, 4);
  assert.equal(s.bufferSeconds, Math.max(20, s.preRollSeconds + 10), 'buffer covers pre-roll and respects the 20-second minimum');
  assert.equal(s.fps, 120);
  assert.equal(s.resolution, 'native');
  assert.equal(s.gameAudio, 'desktop');
  assert.equal(s.recordMic, DEFAULT_SETTINGS.recordMic);
  assert.equal(s.aiProvider, 'none');
  assert.equal(s.rootFolder, DEFAULT_SETTINGS.rootFolder);
  assert.ok(!('somethingElse' in s));
  assert.deepEqual(sanitizeSettings(DEFAULT_SETTINGS), DEFAULT_SETTINGS);
});

test('settings without a specific rule still survive when their type matches the default', () => {
  const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
  const added = 'testOnlySetting';
  defaults[added] = 'a';
  try {
    assert.equal((sanitizeSettings({ [added]: 'b' }) as unknown as Record<string, unknown>)[added], 'b');
    assert.equal((sanitizeSettings({ [added]: 5 }) as unknown as Record<string, unknown>)[added], 'a');
  } finally {
    delete defaults[added];
  }
});

test('settings survive a round trip and a corrupt file falls back to defaults', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
  try {
    saveSettings({ ...DEFAULT_SETTINGS, rootFolder: root, fps: 120 });
    assert.equal(loadSettings(root).fps, 120);
    assert.deepEqual(fs.readdirSync(root), ['settings.json'], 'no temp file left behind');
    fs.writeFileSync(path.join(root, 'settings.json'), '{ broken');
    assert.deepEqual(loadSettings(root), { ...DEFAULT_SETTINGS, rootFolder: root });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('atomic write replaces the file in one step', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
  try {
    const f = path.join(dir, 'a.json');
    writeFileAtomic(f, '1');
    writeFileAtomic(f, '2');
    assert.equal(fs.readFileSync(f, 'utf8'), '2');
    assert.deepEqual(fs.readdirSync(dir), ['a.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clip actions only accept mp4 files inside the clips folder', () => {
  const clips = path.resolve('/lib/clips');
  assert.equal(isClipFile(path.join(clips, '2026-11', 'a.mp4'), clips), true);
  assert.equal(isClipFile(path.join(clips, 'a.MP4'), clips), true);
  assert.equal(isClipFile(path.join(clips, '..', 'settings.json'), clips), false);
  assert.equal(isClipFile(path.join(clips, '..', 'other', 'a.mp4'), clips), false);
  assert.equal(isClipFile(path.join(clips, 'a.json'), clips), false);
  assert.equal(isClipFile(path.resolve('/elsewhere/a.mp4'), clips), false);
  assert.equal(isClipFile(42, clips), false);
});
