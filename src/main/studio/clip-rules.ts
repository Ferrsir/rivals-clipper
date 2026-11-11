// Rules a reel prompt sets on which library clips may be used: "only Deadpool clips", "no Magik",
// "triples or better", "team wipes only". Read straight from the words, so they never depend on the
// AI noticing them, and applied as hard filters everywhere the Studio picks or adds clips
// (the AI's shortlist, its picks, filling to length, and revisions).

import type { ClipRules } from '../../shared/studio';
import type { ClipSidecar } from '../../shared/types';

export type { ClipRules };

/** Marvel Rivals heroes and the names people type for them. The first entry is the canonical name. */
const HEROES: string[][] = [
  ['Adam Warlock', 'adam warlock', 'adam', 'warlock'],
  ['Angela'],
  ['Black Panther', 'black panther', 'panther', 'bp'],
  ['Black Widow', 'black widow', 'widow'],
  ['Blade'],
  ['Captain America', 'captain america', 'cap america', 'cap'],
  ['Cloak & Dagger', 'cloak and dagger', 'cloak & dagger', 'cloak n dagger', 'c&d', 'cnd'],
  ['Daredevil', 'daredevil', 'dare devil', 'dd'],
  ['Deadpool', 'deadpool', 'dead pool', 'dp'],
  ['Doctor Strange', 'doctor strange', 'dr strange', 'dr. strange', 'strange'],
  ['Emma Frost', 'emma frost', 'emma'],
  ['Gambit'],
  ['Groot'],
  ['Hawkeye', 'hawkeye', 'hawk eye'],
  ['Hela'],
  ['Hulk', 'hulk', 'bruce banner', 'banner'],
  ['Human Torch', 'human torch', 'torch', 'johnny storm'],
  ['Invisible Woman', 'invisible woman', 'invis woman', 'invis', 'sue storm'],
  ['Iron Fist', 'iron fist', 'ironfist'],
  ['Iron Man', 'iron man', 'ironman'],
  ['Jeff the Land Shark', 'jeff the land shark', 'jeff'],
  ['Loki'],
  ['Luna Snow', 'luna snow', 'luna'],
  ['Magik', 'magik', 'magic', 'illyana'],
  ['Magneto'],
  ['Mantis'],
  ['Mister Fantastic', 'mister fantastic', 'mr fantastic', 'mr. fantastic', 'reed richards', 'reed'],
  ['Moon Knight', 'moon knight', 'moonknight', 'mk'],
  ['Namor'],
  ['Peni Parker', 'peni parker', 'peni'],
  ['Phoenix', 'phoenix', 'jean grey'],
  ['Psylocke', 'psylocke', 'psy'],
  ['Rocket Raccoon', 'rocket raccoon', 'rocket'],
  ['Rogue'],
  ['Scarlet Witch', 'scarlet witch', 'wanda', 'witch'],
  ['Spider-Man', 'spider-man', 'spider man', 'spiderman', 'spidey'],
  ['Squirrel Girl', 'squirrel girl', 'squirrel', 'sg'],
  ['Star-Lord', 'star-lord', 'star lord', 'starlord'],
  ['Storm'],
  ['The Punisher', 'the punisher', 'punisher'],
  ['The Thing', 'the thing', 'thing'],
  ['Thor'],
  ['Ultron'],
  ['Venom'],
  ['Winter Soldier', 'winter soldier', 'bucky'],
  ['Wolverine', 'wolverine', 'logan', 'wolvie'],
  ['Elsa Bloodstone', 'elsa bloodstone', 'elsa'],
];

/** Names that are also everyday words ("the thing is", "no cap", "magic", "a storm"): only count them next to clip words. */
const AMBIGUOUS = new Set(['cap', 'thing', 'the thing', 'storm', 'rocket', 'blade', 'rogue', 'magic', 'strange', 'witch', 'banner', 'torch', 'squirrel', 'adam', 'reed', 'logan', 'jeff', 'luna', 'emma', 'elsa', 'dp', 'dd', 'bp', 'mk', 'sg', 'psy', 'invis', 'warlock', 'venom', 'phoenix', 'groot', 'hela', 'thor', 'loki', 'mantis', 'angela']);

/** Words that put a hero name in a clip-choice context: "only storm", "storm clips", "storm plays". */
const CLIP_WORD = /^(only|just|clips?|plays?|kills?|edits?|montage|reel|gameplay|mains?|maining|highlights?|spotlight|as|on|with|no|not|without|except|use|using|frags?|streaks?|pov)$/;

const NEGATION = /^(no|not|without|except|excluding|exclude|skip|minus|never|avoid|zero|dont|don't|ban|remove)$/;

const norm = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, "'").trim();
const squash = (s: string) => norm(s).replace(/[^a-z0-9]/g, '');

const ALIAS_TO_HERO = new Map<string, string>();
for (const [name, ...aliases] of HEROES) for (const a of [name, ...aliases]) ALIAS_TO_HERO.set(squash(a), name);

/** Edit distance, for hero names the screen reader got slightly wrong ("DERDPOOL", "DEADPOQOL"). */
function distance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

const FULL_NAMES = HEROES.map(([name]) => ({ name, key: squash(name) }));

/**
 * "MAGIK", "magik", "Dead Pool", "deadpool" -> "Magik" / "Deadpool". Also reads the clipper's noisy
 * screen reads: "A            DEADPOOL" (a stray letter in front), "DERDPOOL", "DEADPOQOL".
 * Anything it can't place is unknown (undefined), so a hero rule never trusts it.
 */
export function canonicalHero(name: string | undefined | null): string | undefined {
  if (!name || typeof name !== 'string') return undefined;
  const key = squash(name);
  if (!key || /^(unknown|none|null|unsure|uncertain)$/.test(key)) return undefined;
  const exact = ALIAS_TO_HERO.get(key);
  if (exact) return exact;
  // The last word on its own: "I   DEADPOOL", "GD DEADPOOL".
  const words = norm(name).split(/[^a-z0-9&]+/).filter(Boolean);
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const hit = ALIAS_TO_HERO.get(squash(words.slice(-n).join(' ')));
    if (hit && squash(words.slice(-n).join(' ')).length >= 4) return hit;
  }
  // The first words on their own, when the rest is misread: "ELSA BLOODS ZED E".
  for (let n = Math.min(3, words.length - 1); n >= 1; n--) {
    const head = squash(words.slice(0, n).join(' '));
    const hit = ALIAS_TO_HERO.get(head);
    if (hit && head.length >= 4) return hit;
  }
  // One or two letters misread in a long name.
  let best: { name: string; d: number } | undefined;
  for (const h of FULL_NAMES) {
    if (h.key.length < 5) continue;
    // OCR glues junk from the HUD onto the front ("CBSBEADPOOL"), so also try the tail that is the hero's length.
    const tails = [h.key.length, h.key.length + 1].filter((n) => key.length > n).map((n) => key.slice(-n));
    for (const k of new Set([key, squash(words[words.length - 1] ?? ''), ...tails])) {
      const d = distance(k, h.key);
      const allowed = h.key.length >= 8 ? 2 : 1;
      if (d <= allowed && (!best || d < best.d)) best = { name: h.name, d };
    }
  }
  return best?.name;
}

export const HERO_NAMES = [...new Set(HEROES.map((h) => h[0]))];

/**
 * Whose clip this is, from the best source there is: the clipper's own read, the hero on its events,
 * the AI tagger's look at the HUD, then an earlier hero check by the Studio.
 */
export function heroOf(c: Pick<ClipSidecar, 'hero' | 'events'> & Partial<Pick<ClipSidecar, 'ai' | 'id'>>, checked?: Map<string, string | null>): string | undefined {
  const direct = canonicalHero(c.hero);
  if (direct) return direct;
  const votes = new Map<string, number>();
  for (const e of c.events ?? []) {
    const h = canonicalHero(e.myHero);
    if (h) votes.set(h, (votes.get(h) ?? 0) + 1);
  }
  const top = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top) return top[0];
  const ai = canonicalHero(c.ai?.hero);
  if (ai) return ai;
  const seen = c.id ? checked?.get(c.id) : undefined;
  return canonicalHero(seen ?? undefined);
}

export const NO_RULES: ClipRules = { heroes: [], notHeroes: [] };

export const hasRules = (r: ClipRules | undefined): r is ClipRules => !!r && (r.heroes.length > 0 || r.notHeroes.length > 0 || !!r.minKills || !!r.needTags?.length || !!r.bots);

const PICTURE_WORD = /^(icon|picture|pic|image|photo|logo|sticker|emoji|png|face|pfp)$/;

/** Read the hero and kill-count rules out of a prompt. */
export function readClipRules(text: string | undefined): ClipRules {
  const t = norm(text ?? '').replace(/[^a-z0-9&'.\-+\s]/g, ' ');
  const words = t.split(/\s+/).filter(Boolean);
  const heroes: string[] = [];
  const notHeroes: string[] = [];
  let lastHeroEnd = -10;
  let lastNegated = false;
  for (let i = 0; i < words.length; i++) {
    // Longest alias first: "the punisher" before "punisher", "iron man" before nothing.
    let hit: { hero: string; len: number; alias: string } | undefined;
    for (let len = 4; len >= 1 && !hit; len--) {
      if (i + len > words.length) continue;
      const phrase = words.slice(i, i + len).join(' ');
      const hero = ALIAS_TO_HERO.get(squash(phrase));
      if (hero && (len > 1 || squash(phrase).length >= 2)) hit = { hero, len, alias: phrase.replace(/[.\-]/g, ' ').replace(/\s+/g, ' ').trim() };
    }
    if (!hit) continue;
    const before = words.slice(Math.max(0, i - 2), i);
    const after = words.slice(i + hit.len, i + hit.len + 2);
    // "the deadpool icon", "his picture on magik": a picture, not a clip choice.
    if (after.some((w) => PICTURE_WORD.test(w)) || (before.length && /^(on|over)$/.test(before[before.length - 1]) && words.slice(Math.max(0, i - 5), i).some((w) => PICTURE_WORD.test(w)))) {
      i += hit.len - 1;
      continue;
    }
    // "it says magik", "tagged as magik": talking about a label, not asking for that hero.
    const label = words.slice(Math.max(0, i - 3), i).some((w) => /^(says?|said|tagged|labell?ed|named|shows?|showing|listed|marked|called)$/.test(w));
    if (label) {
      i += hit.len - 1;
      continue;
    }
    const slang = hit.alias === 'cap' && before[before.length - 1] === 'no';
    if (slang || (AMBIGUOUS.has(hit.alias) && ![...before, ...after].some((w) => CLIP_WORD.test(w)) && i - lastHeroEnd > 2)) {
      i += hit.len - 1;
      continue;
    }
    // "no magik", "without magik or psylocke": a negation just before, or a list joined to a negated name.
    const joined = i - lastHeroEnd <= 2 && words.slice(lastHeroEnd, i).every((w) => /^(or|and|nor|&|\/|,)$/.test(w));
    // "nothing but deadpool" means only Deadpool; "anything but magik" means no Magik.
    const butNot = before.length === 2 && /^(anything|everything|anyone|anybody)$/.test(before[0]) && before[1] === 'but';
    const onlyBut = before.length === 2 && before[0] === 'nothing' && before[1] === 'but';
    const negated: boolean = !onlyBut && (butNot || before.some((w) => NEGATION.test(w)) || (joined && lastNegated));
    if (negated) {
      if (!notHeroes.includes(hit.hero)) notHeroes.push(hit.hero);
    } else if (!heroes.includes(hit.hero)) heroes.push(hit.hero);
    lastNegated = negated;
    lastHeroEnd = i + hit.len;
    i += hit.len - 1;
  }
  const rules: ClipRules = { heroes: heroes.filter((h) => !notHeroes.includes(h)), notHeroes };
  // Kill counts: "at least 3 kills", "3+ kills", "triples or better", "only multi kills", "team wipes only".
  const atLeast = t.match(/\b(?:at least|min(?:imum)?|over|more than)\s+(\d)\s*(?:kills?|elims?|eliminations?)\b/) ?? t.match(/\b(\d)\s*\+\s*(?:kills?|elims?)\b/);
  if (atLeast) rules.minKills = Number(atLeast[1]) + (/\b(over|more than)\b/.test(atLeast[0]) ? 1 : 0);
  else {
    // "only doubles/triples/quads": the smallest streak named is the floor (not the biggest).
    const qualifier = /\b(only|just|or better|or more|and up|\+)\b/.test(t);
    const named = [
      [2, /\bdoubles?\b|\btwo ?kills?\b|\b2 ?kills?\b/],
      [3, /\btriples?\b|\bthree ?kills?\b|\b3 ?kills?\b/],
      [4, /\bquads?\b|\bquadra|\bfour ?kills?\b/],
      [5, /\b(penta|five) ?(kills?|frags?)\b|\bpentas?\b/],
      [6, /\b(hexa|six) ?(kills?|frags?)?\b/],
    ] as const;
    const counts = named.filter(([n, re]) => re.test(t) && (n !== 6 || /\bonly\b/.test(t))).map(([n]) => n as number);
    if (qualifier && counts.length) rules.minKills = Math.min(...counts);
    else if (/\bmulti[ -]?(kills?|frags?)\b|\bdoubles? or better\b|\bno single kills?\b|\bno (?:1|one)[ -]?kill/.test(t)) rules.minKills = 2;
  }
  // "include bot games", "vs ai is fine": games against AI bots are left out unless you ask for them.
  if (/\b(include|with|allow|use|keep|fine|ok|okay)\b[^.]{0,20}\b(bots?|bot games?|vs\.? ?ai|ai games?|against (?:the )?ai)\b|\b(bots?|bot games?|vs\.? ?ai)\b[^.]{0,12}\b(fine|ok|okay|allowed|too)\b/.test(t)) rules.bots = true;
  if (/\bteam ?wipes?\b|\bwipes? only\b|\bonly wipes?\b/.test(t) && /\b(only|just)\b/.test(t)) rules.needTags = ['team-wipe'];
  return rules;
}

/** Rules for a revision: the new words win where they say something, the project's saved rules hold otherwise. */
export function mergeRules(saved: ClipRules | undefined, next: ClipRules, text: string): ClipRules {
  // "any hero now", "other heroes too", "mix in other heroes": lift the hero rule.
  const lift = /\b(any|all|other|every|different|more) heroe?s?\b|\bmix (it up|in)\b|\bnot just\b|\bdrop the hero rule\b/i.test(text);
  const base = saved ?? NO_RULES;
  return {
    heroes: next.heroes.length ? next.heroes : lift ? [] : base.heroes.filter((h) => !next.notHeroes.includes(h)),
    notHeroes: [...new Set([...(lift ? [] : base.notHeroes.filter((h) => !next.heroes.includes(h))), ...next.notHeroes])],
    minKills: next.minKills ?? base.minKills,
    needTags: next.needTags ?? base.needTags,
    ...(next.bots ?? base.bots ? { bots: true } : {}),
  };
}

export interface RuleCheck {
  ok: boolean;
  /** Why the clip was left out, for notes. */
  reason?: 'hero' | 'unknown-hero' | 'kills' | 'tag';
}

/** Does this clip follow the rules? A clip whose hero can't be told never passes a hero rule. */
export function checkClip(rules: ClipRules, c: { hero?: string; kills: number; tags: string[]; streak?: { kills: number } }): RuleCheck {
  const hero = canonicalHero(c.hero);
  if (rules.heroes.length) {
    if (!hero) return { ok: false, reason: 'unknown-hero' };
    if (!rules.heroes.includes(hero)) return { ok: false, reason: 'hero' };
  }
  if (hero && rules.notHeroes.includes(hero)) return { ok: false, reason: 'hero' };
  // A multi-kill split across two clips counts as the whole streak (streaks.ts joins them back up).
  if (rules.minKills && Math.max(c.kills, c.streak?.kills ?? 0) < rules.minKills) return { ok: false, reason: 'kills' };
  if (rules.needTags?.length && !rules.needTags.some((t) => c.tags.includes(t))) return { ok: false, reason: 'tag' };
  return { ok: true };
}

const killCount = (c: ClipSidecar) => c.events.filter((e) => e.type === 'kill').length;

/** Library clips that follow the rules. */
export function filterLibrary(rules: ClipRules, clips: ClipSidecar[], checked?: Map<string, string | null>, opts: { killsChecked?: boolean } = {}): ClipSidecar[] {
  if (!hasRules(rules)) return clips;
  // The clipper's kill counts are often wrong (teammates' kills) and a split multi-kill shows as singles:
  // when the kill feed is read afterwards (killsChecked), the kill rule waits for that.
  const r = opts.killsChecked ? { ...rules, minKills: undefined } : rules;
  return clips.filter((c) => checkClip(r, { hero: heroOf(c, checked), kills: killCount(c), tags: c.tags }).ok);
}

/** "only Deadpool, no Magik, 3+ kills" for notes and the AI prompt. */
export function describeRules(r: ClipRules): string {
  const parts: string[] = [];
  if (r.heroes.length) parts.push(`only ${list(r.heroes)} clips`);
  if (r.notHeroes.length) parts.push(`no ${list(r.notHeroes, 'or')} clips`);
  if (r.minKills) parts.push(`at least ${r.minKills} kills in every clip or streak`);
  if (r.bots) parts.push('bot games allowed');
  if (r.needTags?.includes('team-wipe')) parts.push('team wipes only');
  return parts.join(', ');
}

const list = (a: string[], joiner = 'and') => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} ${joiner} ${a[a.length - 1]}`);

export function sanitizeRules(v: unknown): ClipRules | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const names = (x: unknown) => (Array.isArray(x) ? x : []).map((h) => canonicalHero(typeof h === 'string' ? h.slice(0, 60) : undefined)).filter((h): h is string => !!h).slice(0, 20);
  const r: ClipRules = {
    heroes: [...new Set(names(o.heroes))],
    notHeroes: [...new Set(names(o.notHeroes))],
    minKills: Number.isInteger(o.minKills) && (o.minKills as number) >= 1 && (o.minKills as number) <= 6 ? (o.minKills as number) : undefined,
    needTags: Array.isArray(o.needTags) ? o.needTags.filter((t): t is string => typeof t === 'string').map((t) => t.slice(0, 30)).slice(0, 5) : undefined,
  };
  if (o.bots === true) r.bots = true;
  if (!r.needTags?.length) delete r.needTags;
  if (r.minKills === undefined) delete r.minKills;
  return hasRules(r) ? r : undefined;
}
