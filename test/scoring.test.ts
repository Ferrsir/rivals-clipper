import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreClip } from '../src/main/scoring';
import { MatchState } from '../src/main/match-state';
import type { ClipEvent } from '../src/shared/types';

const kill = (at: number, extra: Partial<ClipEvent> = {}): ClipEvent => ({ type: 'kill', at, ...extra });

test('a fast triple kill outscores three spread-out single kills', () => {
  const triple = scoreClip({ events: [kill(0), kill(1500), kill(3000)], match: {}, trigger: 'auto', ultUsedBeforeKills: false });
  const single = scoreClip({ events: [kill(0)], match: {}, trigger: 'auto', ultUsedBeforeKills: false });
  assert.ok(triple.tags.includes('triple'));
  assert.ok(triple.tags.includes('fast'));
  assert.ok(triple.score > single.score * 3);
});

test('clutch, healer kills, ult and match winner are tagged', () => {
  const r = scoreClip({
    events: [
      kill(0, { teammatesAlive: 2, victimRole: 'Strategist' }),
      kill(2000, { teammatesAlive: 1, enemiesAlive: 0 }),
    ],
    match: { gameType: 'Competitive' },
    trigger: 'auto',
    ultUsedBeforeKills: true,
    endedMatch: 'Victory',
    hero: 'Magik',
  });
  for (const t of ['double', 'clutch', 'healer-hunt', 'team-wipe', 'ult', 'match-winner', 'hero:Magik']) assert.ok(r.tags.includes(t), t);
});

test('your star rating moves the score', () => {
  const base = { events: [kill(0)], match: {}, trigger: 'auto' as const, ultUsedBeforeKills: false };
  assert.ok(scoreClip({ ...base, rating: 5 }).score > scoreClip({ ...base, rating: 1 }).score);
});

test('match state parses GEP roster strings and matches kill feed victims', () => {
  const s = new MatchState();
  s.onInfoUpdate('game_info', 'player_name', 'Ferris', 0);
  s.onInfoUpdate('match_info', 'roster_0', JSON.stringify({ name: 'Ferris', character_name: 'Magik', is_local: 'true', is_teammate: 'true', is_alive: 'true', ult_charge: '100' }), 0);
  s.onInfoUpdate('match_info', 'roster_6', JSON.stringify({ name: 'Enemy', character_name: 'Luna Snow', is_teammate: 'false', is_alive: 'false' }), 0);
  s.onInfoUpdate('match_info', 'roster_0', JSON.stringify({ name: 'Ferris', character_name: 'Magik', is_local: 'true', is_teammate: 'true', is_alive: 'true', ult_charge: '0' }), 4000);
  s.onKillFeed(JSON.stringify({ attacker: 'Ferris', victim: 'Enemy', victim_character_name: 'Luna Snow', victim_is_teammate: 'false' }), 5000);
  const k = s.describeKill(1, 5100);
  assert.equal(k.victim, 'Enemy');
  assert.equal(k.victimRole, 'Strategist');
  assert.equal(k.myHero, 'Magik');
  assert.equal(k.enemiesAlive, 0);
  assert.equal(s.ultUsedBefore(5100), true);
});

import { quoteWinArg } from '../src/main/ai-auth';

test('Windows args with spaces stay one argument', () => {
  assert.equal(quoteWinArg('C:\\Users\\Jane Doe\\AppData\\Local\\Temp\\a.txt'), '"C:\\Users\\Jane Doe\\AppData\\Local\\Temp\\a.txt"');
  assert.equal(quoteWinArg('Read'), 'Read');
  assert.equal(quoteWinArg('say "hi"'), '"say ""hi"""');
  assert.equal(quoteWinArg(''), '""');
});
