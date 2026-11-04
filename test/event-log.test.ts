import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventLog } from '../src/main/event-log';

test('event log buffers lines, writes them per day and survives bad data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evlog-'));
  try {
    let now = new Date('2026-11-04T23:59:59Z');
    const log = new EventLog(dir, { now: () => now, flushMs: 10_000 });
    log.write('event', { key: 'kill' });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    log.write('event', circular);
    now = new Date('2026-11-05T00:00:01Z');
    log.write('event', { key: 'death' });
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing written until flush');
    await log.flush();
    assert.deepEqual(fs.readdirSync(dir).sort(), ['gep-2026-11-04.jsonl', 'gep-2026-11-05.jsonl']);
    const first = fs.readFileSync(path.join(dir, 'gep-2026-11-04.jsonl'), 'utf8').trim().split('\n');
    assert.equal(first.length, 1);
    assert.equal(JSON.parse(first[0]).data.key, 'kill');
    log.write('status', { msg: 'bye' });
    log.flushSync();
    assert.equal(fs.readFileSync(path.join(dir, 'gep-2026-11-05.jsonl'), 'utf8').trim().split('\n').length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('old daily logs are pruned on startup, other files are left alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evlog-'));
  try {
    for (const f of ['gep-2026-10-01.jsonl', 'gep-2026-10-25.jsonl', 'gep-2026-11-04.jsonl', 'notes.txt']) fs.writeFileSync(path.join(dir, f), '');
    new EventLog(dir, { now: () => new Date('2026-11-04T12:00:00Z'), keepDays: 14 });
    assert.deepEqual(fs.readdirSync(dir).sort(), ['gep-2026-10-25.jsonl', 'gep-2026-11-04.jsonl', 'notes.txt']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
