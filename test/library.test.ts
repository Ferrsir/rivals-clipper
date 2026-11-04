import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Library, facetsOf, queryClips } from '../src/main/library';
import type { ClipSidecar } from '../src/shared/types';

let n = 0;
function clip(p: Partial<ClipSidecar> & { kills?: number }): ClipSidecar {
  n += 1;
  const { kills = 1, ...rest } = p;
  return {
    version: 1,
    id: `c${n}`,
    videoFile: `F:\\RivalsClips\\clips\\c${n}.mp4`,
    createdAt: n * 1000,
    startTimeEpoch: n * 1000,
    durationMs: 20_000,
    trigger: 'auto',
    match: {},
    events: Array.from({ length: kills }, (_, i) => ({ type: 'kill' as const, at: i })),
    ultUsedBeforeKills: false,
    video: { width: 2560, height: 1440, fps: 120 },
    audioTracks: [{ index: 0, label: 'game' }],
    useMic: false,
    score: 10,
    tags: [],
    scoreBreakdown: {},
    ...rest,
  };
}

const magik = clip({ hero: 'Magik', kills: 4, score: 90, tags: ['quad', 'fast', 'hero:Magik'], match: { map: 'Tokyo 2099', gameType: 'Competitive' }, rating: 5 });
const luna = clip({ hero: 'Luna Snow', kills: 1, score: 15, tags: ['single'], match: { map: 'Klyntar', gameType: 'Quick match' } });
const magik2 = clip({ hero: 'Magik', kills: 2, score: 40, tags: ['double', 'healer-hunt'], match: { map: 'Klyntar', gameType: 'Competitive' }, trigger: 'manual', rating: 3 });
const all = [magik, luna, magik2];

test('library filters by hero, map, mode, kills, rating and trigger', () => {
  assert.deepEqual(queryClips(all, { hero: 'magik' }).items.map((c) => c.id), [magik2.id, magik.id]);
  assert.deepEqual(queryClips(all, { map: 'Klyntar', gameType: 'Competitive' }).items, [magik2]);
  assert.deepEqual(queryClips(all, { minKills: 3 }).items, [magik]);
  assert.deepEqual(queryClips(all, { minRating: 4 }).items, [magik]);
  assert.deepEqual(queryClips(all, { trigger: 'manual' }).items, [magik2]);
});

test('library needs every selected tag and searches free text', () => {
  assert.deepEqual(queryClips(all, { tags: ['quad', 'fast'] }).items, [magik]);
  assert.deepEqual(queryClips(all, { tags: ['quad', 'double'] }).items, []);
  assert.deepEqual(queryClips(all, { text: 'luna klyntar' }).items, [luna]);
  assert.deepEqual(queryClips(all, { text: 'tokyo' }).items, [magik]);
});

test('library sorts and pages, reporting the full match count', () => {
  assert.deepEqual(queryClips(all, { sort: 'score' }).items.map((c) => c.id), [magik.id, magik2.id, luna.id]);
  assert.deepEqual(queryClips(all, { sort: 'kills' }).items[0], magik);
  assert.deepEqual(queryClips(all, { sort: 'new' }).items[0], magik2);
  const page = queryClips(all, { sort: 'score', limit: 1, offset: 1 });
  assert.deepEqual(page.items, [magik2]);
  assert.equal(page.total, 3);
});

test('facets count heroes, maps and plain tags', () => {
  const f = facetsOf(all);
  assert.deepEqual(f.heroes[0], { value: 'Magik', count: 2 });
  assert.deepEqual(f.maps[0], { value: 'Klyntar', count: 2 });
  assert.ok(!f.tags.some((t) => t.value.includes(':')));
  assert.equal(f.total, 3);
});

test('library index picks up new, changed and deleted sidecars', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
  try {
    const sub = path.join(dir, '2026-11');
    fs.mkdirSync(sub);
    const a = path.join(sub, 'a.json');
    fs.writeFileSync(a, JSON.stringify(magik));
    fs.writeFileSync(path.join(sub, 'broken.json'), '{ not json');
    const lib = new Library(() => dir);
    assert.equal(lib.query().total, 1);

    fs.writeFileSync(path.join(sub, 'b.json'), JSON.stringify(luna));
    assert.equal(lib.query().total, 2);

    fs.writeFileSync(a, JSON.stringify({ ...magik, rating: 1 }));
    fs.utimesSync(a, new Date(), new Date(Date.now() + 5000));
    assert.equal(lib.query({ hero: 'Magik' }).items[0].rating, 1);

    fs.rmSync(a);
    assert.deepEqual(lib.query().items.map((c) => c.id), [luna.id]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
