import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { ScreenFusion } from '../src/main/vision/fusion';
import { ScreenOcr } from '../src/main/vision/ocr';
import { sanitizeSettings } from '../src/main/settings';
import { StreakTracker } from '../src/main/streak';
import { upload } from '../src/main/studio/publish/tiktok';

test('late OCR trade counts the death exactly once without duplicating the settled kill', () => {
  const events: string[] = [];
  const f = new ScreenFusion({ gameEvent: key => { events.push(key); }, infoUpdate() {} }, { ocr: true, playerName: 'Ferrsir' });
  const box = { x0: 0, y0: 0, x1: 10, y1: 10 }, crop = { w: 10, h: 10, data: new Uint8Array(100) };
  f.onObservation({ kind: 'ko-line', id: 1, t: 1000, box, crop, assist: false });
  f.onObservation({ kind: 'feed-row', id: 2, t: 1050, box, crop });
  f.tick(1800);
  const result = { text: 'Enemy Ferrsir', words: [{ text: 'Enemy', x0: 0, x1: 20, conf: 90 }, { text: 'Ferrsir', x0: 60, x1: 90, conf: 90 }] };
  f.onOcr('feed', 2, result, 2100);
  f.onOcr('feed', 2, result, 2200);
  f.tick(5000);
  assert.equal(events.filter(x => x === 'kill').length, 1);
  assert.equal(events.filter(x => x === 'death').length, 1);
});

test('accepted settings reserve post-roll inside the total clip cap', () => {
  for (const postRollSeconds of [2, 5, 15]) {
    const s = sanitizeSettings({ preRollSeconds: 40, maxClipSeconds: 15, postRollSeconds });
    assert.ok(s.preRollSeconds + s.postRollSeconds <= s.maxClipSeconds);
    const tracker = new StreakTracker({ preRollMs: s.preRollSeconds * 1000, postRollMs: s.postRollSeconds * 1000, maxClipMs: s.maxClipSeconds * 1000 });
    const action = tracker.onKill(100000);
    assert.equal(action.type, 'start');
    if (action.type !== 'start') return;
    assert.ok(action.stopAt > 100000);
    assert.ok(action.stopAt - (100000 - action.pastDurationMs) <= 15000);
  }
});

test('private publishing rejects unsupported visibility before initializing any upload', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'clip.mp4'); fs.writeFileSync(file, 'fixture');
  for (const options of [[], ['PUBLIC_TO_EVERYONE'], ['MUTUAL_FOLLOW_FRIENDS']]) {
    let calls = 0;
    await assert.rejects(upload({ tiktokMode: 'direct' } as any, 'mock', file, { title: 'Test', privacy: 'private' }, () => {}, async () => {
      calls++;
      return new Response(JSON.stringify({ data: { privacy_level_options: options } }), { status: 200 });
    }), /requested privacy/);
    assert.equal(calls, 1, 'only the read-only creator query is allowed');
  }
});

test('render startup locks immediately and keeps its original project and plan key', async () => {
  let resolve!: (r: any) => void;
  let calls = 0;
  const ctx = vm.createContext({ S: { project: { id: 'a', name: 'A', format: 'reels' } },
    saveSoon: { flush() {} }, api: { render: () => { calls++; return new Promise(r => { resolve = r; }); } },
    structuredClone, planKey: () => 'plan-a', renderTop() {}, renderCenter() {}, toast() {}, root: {},
  });
  const source = fs.readFileSync(path.join(__dirname, '../../renderer/studio/index.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('async function startRender(req)'), source.indexOf('function onProgress(p)')), ctx);
  const first = ctx.startRender({ preview: true });
  ctx.S.project = { id: 'b', name: 'B', format: 'reels' };
  await ctx.startRender({ preview: true });
  assert.equal(calls, 1);
  resolve({ jobId: 'a-job' }); await first;
  assert.equal(ctx.S.job.projectId, 'a');
  assert.equal(ctx.S.job.projectName, 'A');
  assert.equal(ctx.S.job.key, 'plan-a');
});

test('OCR recognizes the known fixture, rather than merely incrementing a read counter', async t => {
  const ocr = new ScreenOcr();
  t.after(() => ocr.terminate());
  assert.equal(await ocr.init(), true, ocr.failed);
  const data = fs.readFileSync(path.join(__dirname, '../../test/fixtures/ocr-victory.gray'));
  const result = await ocr.read({ w: 320, h: 70, data }, 'light-text');
  assert.ok(result);
  assert.match(result.text, /\bVICTORY\b/i);
});

test('strict live detection rejects unreadable KOs and merges rapid OCR variants of one victim', () => {
  const events: string[] = [];
  const fusion = new ScreenFusion({ gameEvent: key => { events.push(key); }, infoUpdate() {} }, { ocr: true, strictKills: true });
  const crop = { w: 10, h: 10, data: new Uint8Array(100) }, box = { x0: 0, y0: 0, x1: 10, y1: 10 };
  for (const [id, text] of [[1, 'ilk DEADPQOOL-Easy'], [2, 'DEADPOOL-Easy'], [3, '']] as const) {
    const t = 1000 + id * 400;
    fusion.onObservation({ kind: 'ko-line', id, t, box, crop, assist: false });
    fusion.onOcr('ko', id, { text, words: text ? [{text, x0: 0, x1: 90, conf: 90}] : [] }, t + 100);
  }
  fusion.tick(8000);
  assert.equal(events.filter(k => k === 'kill').length, 1);
});
