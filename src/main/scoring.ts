// Turns a clip's event data into a score and searchable tags.
// Weights live in one object so they can be tuned (and later exposed in the Library UI).

import type { ClipSidecar } from '../shared/types';

export const DEFAULT_WEIGHTS = {
  perKill: 10,
  multiKill: { 2: 10, 3: 30, 4: 60, 5: 100, 6: 150 } as Record<number, number>,
  /** Average gap between kills under this many ms counts as "fast". */
  fastGapMs: 2500,
  fast: 15,
  strategistKill: 5,
  /** Kills made while this many or fewer teammates (incl. you) were alive count as clutch. */
  clutchAlive: 2,
  clutch: 25,
  teamWipe: 50,
  ult: 10,
  competitive: 10,
  matchWinner: 20,
  survived: 5,
  /** Each star above/below 3 adds/removes this much. */
  perStar: 25,
  /** AI hype score: each point above/below 5 adds/removes this much. */
  perHype: 4,
};

export type Weights = typeof DEFAULT_WEIGHTS;

const MULTI_NAMES: Record<number, string> = { 2: 'double', 3: 'triple', 4: 'quad', 5: 'penta', 6: 'hexa' };

type Scorable = Pick<ClipSidecar, 'events' | 'match' | 'trigger' | 'ultUsedBeforeKills' | 'endedMatch' | 'rating' | 'hero'> & Partial<Pick<ClipSidecar, 'ai'>>;

export function scoreClip(clip: Scorable, w: Weights = DEFAULT_WEIGHTS): { score: number; tags: string[]; breakdown: Record<string, number> } {
  const kills = clip.events.filter((e) => e.type === 'kill').sort((a, b) => a.at - b.at);
  const deaths = clip.events.filter((e) => e.type === 'death');
  const breakdown: Record<string, number> = {};
  const tags = new Set<string>();
  const add = (k: string, v: number) => {
    if (v) breakdown[k] = (breakdown[k] ?? 0) + v;
  };

  if (clip.trigger === 'manual') tags.add('manual');
  if (clip.hero) tags.add(`hero:${clip.hero}`);
  if (clip.match.map) tags.add(`map:${clip.match.map}`);
  if (clip.match.gameType) tags.add(`mode:${clip.match.gameType}`);

  add('kills', kills.length * w.perKill);
  if (kills.length >= 1) tags.add(`${kills.length}k`);

  const tier = Math.min(kills.length, 6);
  if (tier >= 2) {
    add('multiKill', w.multiKill[tier] ?? 0);
    tags.add(MULTI_NAMES[tier]);
  }

  if (kills.length >= 2) {
    const avgGap = (kills[kills.length - 1].at - kills[0].at) / (kills.length - 1);
    if (avgGap <= w.fastGapMs) {
      add('fast', w.fast);
      tags.add('fast');
    }
  }

  const strategistKills = kills.filter((k) => k.victimRole === 'Strategist').length;
  if (strategistKills) {
    add('strategistKills', strategistKills * w.strategistKill);
    tags.add('healer-hunt');
  }

  const clutchKills = kills.filter((k) => k.teammatesAlive !== undefined && k.teammatesAlive <= w.clutchAlive);
  if (clutchKills.length >= 2) {
    add('clutch', w.clutch);
    tags.add('clutch');
  }

  if (kills.some((k) => k.enemiesAlive === 0) || new Set(kills.map((k) => k.victim).filter(Boolean)).size >= 6) {
    add('teamWipe', w.teamWipe);
    tags.add('team-wipe');
  }

  if (clip.ultUsedBeforeKills && kills.length) {
    add('ult', w.ult);
    tags.add('ult');
  }

  if (clip.match.gameType === 'Competitive') add('competitive', w.competitive);

  if (clip.endedMatch === 'Victory' && kills.length) {
    add('matchWinner', w.matchWinner);
    tags.add('match-winner');
  }

  if (kills.length && deaths.length === 0) add('survived', w.survived);
  if (deaths.length) tags.add('died');

  if (clip.rating !== undefined) add('rating', (clip.rating - 3) * w.perStar);

  if (clip.ai && !clip.ai.error) {
    for (const t of clip.ai.tags) tags.add(t);
    if (clip.ai.hype) add('aiHype', (clip.ai.hype - 5) * w.perHype);
  }

  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { score, tags: [...tags], breakdown };
}
