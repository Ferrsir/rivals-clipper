// Ferris (2026-11-09): "I tell it to only use Deadpool clips and then it'll add in random Magik clips."
// Hero and kill rules in a prompt are hard limits on every clip the Studio picks or adds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClipSidecar } from '../src/shared/types';
import type { MusicAnalysis } from '../src/shared/studio';
import { canonicalHero, checkClip, filterLibrary, heroOf, mergeRules, readClipRules, sanitizeRules } from '../src/main/studio/clip-rules';
import { parseHeroes } from '../src/main/studio/hero-check';
import { styleFromPrompt } from '../src/main/studio/intent';
import { getStyle } from '../src/main/studio/styles';
import { fitToTarget } from '../src/main/studio/fit';
import { createProject, reelClipFromSidecar, sanitizeProject } from '../src/main/studio/projects';
import { checkClip as check } from '../src/main/studio/clip-rules';
import { scoreClip } from '../src/main/scoring';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-rules-'));
function lib(id: string, hits: number[], score: number, hero?: string): ClipSidecar {
  const file = path.join(dir, `${id}.mp4`);
  fs.writeFileSync(file, '');
  return { version: 1, id, videoFile: file, createdAt: 1, startTimeEpoch: 0, durationMs: (hits.at(-1)! + 4) * 1000, trigger: 'auto', hero, match: {}, events: hits.map((h) => ({ type: 'kill', at: h * 1000 })), ultUsedBeforeKills: false, video: { width: 1920, height: 1080, fps: 60 }, audioTracks: [{ index: 0, label: 'game' }], useMic: false, score, tags: [], scoreBreakdown: {} } as unknown as ClipSidecar;
}
function grid(bpm = 128, seconds = 120): MusicAnalysis {
  const step = 60 / bpm;
  const beats = Array.from({ length: Math.floor(seconds / step) }, (_, i) => Math.round(i * step * 1000) / 1000);
  return { version: 1, durationSec: seconds, bpm, beats, downbeats: beats.filter((_, i) => i % 4 === 0), beatEnergy: beats.map(() => 0.5), drops: [beats[64]], energy: 0.7, confidence: 0.9, peaks: [] };
}

test('hero rules are read from the ways people write them', () => {
  assert.deepEqual(readClipRules('only use deadpool clips').heroes, ['Deadpool']);
  assert.deepEqual(readClipRules('i say deadpool clips and it keeps getting random clips, i want only deadpool').heroes, ['Deadpool']);
  assert.deepEqual(readClipRules('30 second DEADPOOL edit to phonk').heroes, ['Deadpool']);
  const r = readClipRules('only deadpool, no magik or psylocke');
  assert.deepEqual(r.heroes, ['Deadpool']);
  assert.deepEqual(r.notHeroes, ['Magik', 'Psylocke']);
  assert.deepEqual(readClipRules("don't use magik clips").notHeroes, ['Magik']);
  assert.deepEqual(readClipRules('anything but magik').notHeroes, ['Magik']);
  assert.deepEqual(readClipRules('nothing but deadpool').heroes, ['Deadpool']);
  assert.deepEqual(readClipRules('the punisher and iron man spotlight').heroes, ['The Punisher', 'Iron Man']);
  assert.deepEqual(readClipRules('spiderman plays').heroes, ['Spider-Man']);
});

test('words that only look like heroes are not rules', () => {
  const none = (t: string) => {
    const r = readClipRules(t);
    assert.deepEqual([r.heroes, r.notHeroes], [[], []], t);
  };
  none('the thing is it keeps adding bad clips');
  none('no cap this edit is mid, make it hit harder');
  none('add some magic to the transitions');
  none('heres gojo vs toji, put the deadpool icon on gojo');
  none('make it 30 seconds to the song aizo');
  // Talking about a label isn't asking for that hero.
  assert.deepEqual(readClipRules('is clip 4 a deadpool clip? it says magik you bafoon'), { heroes: ['Deadpool'], notHeroes: [] });
  // Next to clip words, the short names do count.
  assert.deepEqual(readClipRules('only storm clips').heroes, ['Storm']);
});

test('kill-count rules', () => {
  assert.equal(readClipRules('triples or better only').minKills, 3);
  assert.equal(readClipRules('only multi kills').minKills, 2);
  assert.equal(readClipRules('at least 3 kills per clip').minKills, 3);
  assert.equal(readClipRules('4+ kills').minKills, 4);
  assert.deepEqual(readClipRules('only team wipes').needTags, ['team-wipe']);
  assert.equal(readClipRules('my best kills').minKills, undefined);
});

test('a hero rule never lets in a clip of another hero or one whose hero is unknown', () => {
  const rules = readClipRules('only deadpool');
  assert.equal(checkClip(rules, { hero: 'DEADPOOL', kills: 2, tags: [] }).ok, true);
  assert.deepEqual(checkClip(rules, { hero: 'MAGIK', kills: 5, tags: [] }), { ok: false, reason: 'hero' });
  assert.deepEqual(checkClip(rules, { hero: undefined, kills: 5, tags: [] }), { ok: false, reason: 'unknown-hero' });
  // "no Magik" alone still allows unknown heroes.
  assert.equal(check(readClipRules('no magik'), { kills: 1, tags: [] }).ok, true);
});

test('hero names from the clipper, the events, the AI tagger and the Studio check all count', () => {
  assert.equal(canonicalHero('MAGIK'), 'Magik');
  assert.equal(canonicalHero('dead pool'), 'Deadpool');
  // What the clipper's screen reader actually saved on Ferris's PC.
  for (const raw of ['DERDPOOL', 'DEADPOQOL', 'A            DEADPOOL', 'I                 DEADPOOL', 'GD   DEADPOOL', 'SPIDER-MAN']) assert.ok(['Deadpool', 'Spider-Man'].includes(canonicalHero(raw)!), raw);
  assert.equal(canonicalHero('Y JAIIS'), undefined);
  const c = lib('x', [3], 10);
  assert.equal(heroOf(c), undefined);
  assert.equal(heroOf({ ...c, events: [{ type: 'kill', at: 1, myHero: 'DEADPOOL' }] }), 'Deadpool');
  assert.equal(heroOf({ ...c, ai: { hero: 'Deadpool', tags: [], summary: '', hype: 5, provider: 'claude', at: 1 } }), 'Deadpool');
  assert.equal(heroOf(c, new Map([['x', 'Deadpool']])), 'Deadpool');
  const library = [lib('dp1', [3], 50, 'DEADPOOL'), lib('mg1', [3, 4], 90, 'MAGIK'), lib('u1', [3], 70), lib('u2', [3], 60)];
  const allowed = filterLibrary(readClipRules('only deadpool clips'), library, new Map([['u1', 'Deadpool'], ['u2', null]]));
  assert.deepEqual(allowed.map((c) => c.id), ['dp1', 'u1']);
});

test('the AI hero check only accepts real hero names, one per clip', () => {
  assert.deepEqual(parseHeroes({ heroes: ['Deadpool', 'magik', 'Gojo', null] }, 4), ['Deadpool', 'Magik', null, null]);
  assert.deepEqual(parseHeroes('nonsense', 2), [null, null]);
});

test('filling to length with a Deadpool rule never adds Magik clips, even if the reel ends up short', () => {
  const library = [lib('dp1', [3, 4], 60, 'DEADPOOL'), lib('dp2', [3], 40, 'DEADPOOL'), ...Array.from({ length: 8 }, (_, i) => lib(`mg${i}`, [3, 3.8, 4.5], 90 + i, 'MAGIK'))];
  const rules = readClipRules('only deadpool clips');
  const p = createProject({ format: 'square' });
  p.clips = [reelClipFromSidecar(library[0])];
  p.music = { trackId: 't', file: '/m.mp3', title: 'Song', start: 'auto' };
  p.targetSeconds = 30;
  const r = fitToTarget(p, filterLibrary(rules, library), grid());
  assert.deepEqual(r.added, ['dp2']);
  assert.ok(r.project.clips.every((c) => c.hero === 'DEADPOOL'));
});

test('rules stay with the project, and a later "add more clips" keeps them', () => {
  const p = createProject({});
  p.clipRules = readClipRules('only deadpool, no magik');
  const back = sanitizeProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(back.clipRules, { heroes: ['Deadpool'], notHeroes: ['Magik'] });
  assert.equal(sanitizeRules({ heroes: [] , notHeroes: [] }), undefined);
  const more = mergeRules(back.clipRules, readClipRules('add more clips'), 'add more clips');
  assert.deepEqual(more.heroes, ['Deadpool']);
  const swap = mergeRules(back.clipRules, readClipRules('make it all psylocke'), 'make it all psylocke');
  assert.deepEqual(swap.heroes, ['Psylocke']);
  const lifted = mergeRules(back.clipRules, readClipRules('use any hero now'), 'use any hero now');
  assert.deepEqual(lifted.heroes, []);
});

test('effect rules in the prompt change the style', () => {
  const base = getStyle('velocity');
  const a = styleFromPrompt('deadpool edit, no slow-mo and no shake please', base);
  assert.equal(a.style.slowmo.on, false);
  assert.equal(a.style.shake.on, false);
  assert.equal(a.style.zoom.on, true);
  assert.deepEqual(a.changes, ['no slow-mo', 'no shake']);
  const b = styleFromPrompt('clean edit, just hard cuts', base);
  assert.equal(b.style.transition, 'cut');
  assert.equal(b.style.flash.on || b.style.echo.on || b.style.rgbSplit.on || b.style.slowmo.on, false);
  const c = styleFromPrompt('slow mo on every kill', getStyle('montage'));
  assert.equal(c.style.slowmo.on, true);
  assert.equal(c.style.slowmo.scope, 'all');
  assert.deepEqual(styleFromPrompt('30 second deadpool edit to phonk', base).changes, []);
});

test('assists add a little to a clip score', () => {
  const c = lib('a', [3], 0);
  const plain = scoreClip(c).score;
  const withAssists = scoreClip({ ...c, events: [...c.events, { type: 'assist', at: 2000 }, { type: 'assist', at: 2500 }] });
  assert.equal(withAssists.score, plain + 6);
  assert.ok(withAssists.tags.includes('assists'));
});

test('a song that starts mid-track syncs to the drop inside the chosen part', async () => {
  const { firstDrop } = await import('../src/main/studio/planner');
  const an = { ...grid(134), drops: [11.8, 63.54] };
  assert.equal(firstDrop(an, 46), 63.54);
  assert.equal(firstDrop(an, 0), 11.8);
  assert.equal(firstDrop(an, 70), undefined);
});

// 2026-11-09 18:30–18:34: names the clipper read off Ferris's screen for Deadpool.
test('screen misreads with junk glued on still snap to the hero', () => {
  for (const raw of ['CBSBEADPOOL', 'DEADPQOOL', 'DEXDPOOL', 'GPADPOOL', 'OC                 DEADROOL', 'YE              DEADPROL']) assert.equal(canonicalHero(raw), 'Deadpool', raw);
  assert.equal(canonicalHero('ELSA BLOODS ZED E'), 'Elsa Bloodstone');
  assert.equal(canonicalHero('IE NM ND DEADPOOL'), 'Deadpool');
  assert.equal(canonicalHero('R CAA'), undefined);
});
