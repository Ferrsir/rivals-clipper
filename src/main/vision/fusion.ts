// Turns what the screen detectors see into the same events Overwolf's GEP sends, so main.ts, the
// streak logic, scoring and the Library work unchanged.
//
// Evidence for "you got a KO", strongest first:
//   1. a new name in the KO list next to your crosshair (only your KOs appear there),
//   2. a new light-background kill-feed row with your name on the left (needs text recognition),
//   3. a "N PLAYER KO STREAK!" banner with no KO seen just before it (catches a missed one).
// A KO-list name and a feed row within 1.5 s of each other are the same KO.
// A light feed row with your name on the right is your death.
//
// Match state: the round/timer bar with blue and red team colours only shows in a real match.
// It appearing = match start; gone for a while or a VICTORY/DEFEAT screen = match end.
// Practice Range = kills with no match bar showing, or the map label saying Practice Range.
//
// Only YOUR finals and assists count, and only while YOU are the one playing:
//   - after your death the camera follows a teammate, and their KO list / kill-feed row would look like
//     yours, so for a while after you die only KOs with your own name in the feed row count;
//   - a light kill-feed row with two names and neither is yours means the game is showing someone
//     else's view (spectating, a replay): the same rule applies for a while;
//   - SPECTATING / REPLAY / RESPAWN text on screen means the same.
// Pure logic: time comes in with the observations, so it is unit-tested with recorded sequences.

import type { Observation } from './detectors';
import type { RegionId } from './layout';

export interface EventSink {
  /** Same keys as GEP's match_info events. `at` is when it happened on screen (epoch ms). */
  gameEvent(key: 'kill' | 'death' | 'assist' | 'kill_feed' | 'match_start' | 'match_end', value: unknown, at: number): void;
  infoUpdate(feature: 'game_info' | 'match_info', key: string, value: unknown): void;
}

export type OcrKind = 'feed' | 'ko' | 'banner' | 'map' | 'outcome' | 'subtitle' | 'status';

export interface OcrWord {
  text: string;
  x0: number;
  x1: number;
  conf: number;
}

export interface OcrResult {
  text: string;
  words: OcrWord[];
}

export interface FusionOptions {
  /** Your in-game name. When empty it is learned from the kill feed. */
  playerName?: string;
  /** Whether text recognition is running (otherwise kills come only from the KO list and banners). */
  ocr: boolean;
  strictKills?: boolean;
  pairWindowMs?: number;
  decideAfterMs?: number;
  /** No longer used: a KO with no match bar is the Practice Range straight away. */
  practiceAfterMs?: number;
  matchEndAfterMs?: number;
  /** The match bar has been recognised on this PC before (remembered across sessions). */
  hudVerified?: boolean;
}

export interface FusionCallbacks {
  /** Text recognition wanted for an observation or a region crop. */
  requestOcr?: (req: { id: number; kind: OcrKind }) => void;
  /** Ask the analyzer for a crop of a region with the next frame. */
  wantCrop?: (region: RegionId) => void;
  onHudVerified?: () => void;
  onNameLearned?: (name: string) => void;
}

interface KoItem {
  id: number;
  t: number;
  victim?: string;
  ocrDone: boolean;
  feed?: FeedItem;
  done: boolean;
  /** The line has the assist icon: you helped, someone else got the KO. */
  assist?: boolean;
}

/** A KO stays in the list for a few seconds; the same name again that soon is the same KO seen twice (nobody respawns and dies to you again that fast). */
const SAME_VICTIM_MS = 5000;
/** A KO this soon after your death is still yours (a projectile or a trade). */
const DEATH_GRACE_MS = 1500;
/** After your death, KOs are someone else's (the camera follows a teammate) unless your name is on them. Respawns take about 10 s. */
const DEAD_MS = 10_000;
/** How long one sign of watching someone else (their feed row) holds. */
const WATCH_MS = 8000;
/** Text the game shows when you are not the one playing. */
const NOT_PLAYING_WORDS = /\b(SPECTATING|SPECTATOR|SPECTATE|OBSERVING|OBSERVER|REPLAY|RESPAWNING|RESPAWN\s+IN)\b/i;

interface FeedItem {
  id: number;
  t: number;
  ocr?: OcrResult;
  ocrDone: boolean;
  ko?: KoItem;
  done: boolean;
}

interface BannerItem {
  id: number;
  t: number;
  count?: number;
  ocrDone: boolean;
  done: boolean;
}

export const MAP_NAMES = [
  'Yggsgard: Royal Palace', 'Yggsgard: Yggdrasill Path', 'Tokyo 2099: Shin-Shibuya', 'Tokyo 2099: Spider-Islands',
  'Tokyo 2099: Ninomaru', "Intergalactic Empire of Wakanda: Birnin T'Challa", 'Intergalactic Empire of Wakanda: Hall of Djalia',
  'Intergalactic Empire of Wakanda: Imperial Institute of Science', "Hydra Charteris Base: Hell's Heaven",
  'Hydra Charteris Base: Frozen Airfield', 'Klyntar: Symbiotic Surface', 'Klyntar: Celestial Husk',
  'Empire of Eternal Night: Midtown', 'Empire of Eternal Night: Central Park', 'Empire of Eternal Night: Sanctum Sanctorum',
  'Krakoa: Hellfire Gala', 'Arakko', 'Hall of Djalia',
];

const PRACTICE_WORDS = /PRACTICE|TRAINING|TUTORIAL|RANGE/i;

export function normalizeName(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** 0..1, 1 = same after normalising. OCR mixes up I/l/1 and O/0, so those count as equal. */
export function nameSimilarity(a: string, b: string): number {
  const fold = (s: string) => normalizeName(s).replace(/[IL1|]/g, 'I').replace(/[O0Q]/g, 'O').replace(/5/g, 'S').replace(/8/g, 'B');
  const x = fold(a);
  const y = fold(b);
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

/** Words from OCR that look like part of a player name (icons come out as short junk). */
function nameWords(words: OcrWord[]): OcrWord[] {
  return words.filter((w) => normalizeName(w.text).length >= 3 && w.conf >= 30);
}

export class ScreenFusion {
  kills = 0;
  deaths = 0;
  inMatch = false;
  practice = false;
  playerName?: string;
  private kos: KoItem[] = [];
  private feed: FeedItem[] = [];
  private banners: BannerItem[] = [];
  private lastKillAt = -Infinity;
  private recentVictims: Array<{ name: string; at: number }> = [];
  assists = 0;
  private hudSeenAt = -Infinity;
  private hudLostAt = -Infinity;
  private hudWindow: Array<{ t: number; v: boolean }> = [];
  private matchStartAt = -Infinity;
  private outcomeUntil = -Infinity;
  private nextOutcomeAt = 0;
  private nextSubtitleAt = 0;
  private subtitleHero?: string;
  private mapRequests: number[] = [];
  private mapKnown = false;
  private hudVerified: boolean;
  private startedAt?: number;
  /** Words seen in your feed rows, to learn your name. */
  private nameVotes = new Map<string, number>();
  /** When you last died (your name on the right of a feed row). */
  private deadAt = -Infinity;
  /** Until when the screen is showing someone else's view. */
  private watchingUntil = -Infinity;
  private nextStatusAt = 0;
  private nextMapPollAt = 0;
  /** The map label said Practice Range: stay in practice even if something looks like a match bar. */
  private practiceByLabel = false;
  /** KOs and assists that were seen but not counted because you weren't the one playing. */
  ignored = 0;
  private feedRowsRead = 0;
  private o: Required<Omit<FusionOptions, 'playerName' | 'hudVerified'>>;

  constructor(private sink: EventSink, opts: FusionOptions, private cb: FusionCallbacks = {}) {
    this.playerName = opts.playerName?.trim() || undefined;
    this.hudVerified = !!opts.hudVerified;
    this.o = {
      ocr: opts.ocr,
      strictKills: opts.strictKills ?? false,
      pairWindowMs: opts.pairWindowMs ?? 1500,
      decideAfterMs: opts.decideAfterMs ?? 700,
      practiceAfterMs: opts.practiceAfterMs ?? 90_000,
      matchEndAfterMs: opts.matchEndAfterMs ?? 45_000,
    };
  }

  /** The name used in kill_feed events and sent as player_name. */
  get me(): string {
    return this.playerName ?? 'You';
  }

  begin(t: number): void {
    this.startedAt = t;
    this.sink.infoUpdate('game_info', 'player_name', this.me);
  }

  onObservation(o: Observation): void {
    if (this.startedAt === undefined) this.begin(o.t);
    switch (o.kind) {
      case 'ko-line': {
        const item: KoItem = { id: o.id, t: o.t, ocrDone: !this.o.ocr, done: false, assist: o.assist };
        this.kos.push(item);
        // An assist has no feed row of yours (someone else's name is on the left).
        const f = o.assist ? undefined : this.feed.find((x) => !x.ko && !x.done && Math.abs(x.t - o.t) <= this.o.pairWindowMs);
        if (f) this.pair(item, f);
        if (this.o.ocr) this.cb.requestOcr?.({ id: o.id, kind: 'ko' });
        break;
      }
      case 'feed-row': {
        const item: FeedItem = { id: o.id, t: o.t, ocrDone: !this.o.ocr, done: false };
        this.feed.push(item);
        const k = this.kos.find((x) => !x.feed && !x.assist && Math.abs(x.t - o.t) <= this.o.pairWindowMs);
        if (k) this.pair(k, item);
        if (this.o.ocr) this.cb.requestOcr?.({ id: o.id, kind: 'feed' });
        break;
      }
      case 'banner':
        this.banners.push({ id: o.id, t: o.t, ocrDone: !this.o.ocr, done: false });
        if (this.o.ocr) this.cb.requestOcr?.({ id: o.id, kind: 'banner' });
        break;
      case 'hud':
        this.onHud(o.t, o.matchHud);
        break;
      case 'crop':
        if (this.o.ocr && (o.region === 'map' || o.region === 'outcome' || o.region === 'subtitle' || o.region === 'status')) this.cb.requestOcr?.({ id: o.t, kind: o.region });
        break;
    }
  }

  onOcr(kind: OcrKind, id: number, r: OcrResult | undefined, now: number): void {
    switch (kind) {
      case 'ko': {
        const k = this.kos.find((x) => x.id === id);
        if (!k) return;
        k.ocrDone = true;
        const words = r ? nameWords(r.words) : [];
        if (words.length) k.victim = words.map((w) => w.text).join(' ').trim();
        break;
      }
      case 'feed': {
        const f = this.feed.find((x) => x.id === id);
        if (!f) return;
        f.ocrDone = true;
        f.ocr = r;
        if (r) this.learnName(r);
        if (r && this.foreignRow(r)) this.markWatching(f.t, WATCH_MS, 'someone else\'s kill-feed row');
        // A KO may have settled before its paired row was read. Preserve the
        // already-counted kill, but still account for a trade revealed by OCR.
        if (f.done && f.ko?.done && !f.ko.assist && r && this.sidesOf(r)?.mine === 'victim') {
          f.ko.feed = undefined;
          f.ko = undefined;
          this.emitDeath(f.t, this.sidesOf(r)?.attacker);
        }
        break;
      }
      case 'banner': {
        const b = this.banners.find((x) => x.id === id);
        if (!b) return;
        b.ocrDone = true;
        const m = r?.text.match(/\b(\d{1,2})\s*PLAYER\s+K[O0]\s+STREAK\b/i);
        if (m) b.count = Number(m[1]);
        // Not a streak banner after all (another message in the same place).
        if (r && r.text.trim() && !/KO|STREAK|PLAYER/i.test(r.text)) b.done = true;
        break;
      }
      case 'map': {
        const text = r?.text ?? '';
        if (PRACTICE_WORDS.test(text)) {
          this.practiceByLabel = true;
          this.enterPractice(now, 'map label');
        }
        const best = bestMap(text);
        // A real map name: whatever said Practice Range before is over.
        if (best) this.practiceByLabel = false;
        if (best && !this.mapKnown) {
          this.mapKnown = true;
          this.sink.infoUpdate('match_info', 'map', best);
        }
        break;
      }
      case 'subtitle': {
        if (!this.playerName || !r) break;
        // Only a speaker explicitly associated with our exact player name can identify us.
        const escaped = this.playerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = r.text.match(new RegExp('(?:^|\\n)\\s*([A-Z][A-Z &-]{2,35})\\s*\\(' + escaped + '\\)\\s*:', 'i'));
        const hero = match?.[1].trim().toUpperCase();
        if (hero && hero !== this.subtitleHero) {
          this.subtitleHero = hero;
          this.sink.infoUpdate('game_info', 'local_hero', hero);
        }
        break;
      }
      case 'status': {
        if (r && NOT_PLAYING_WORDS.test(r.text)) this.markWatching(now - 1000, 4000, 'spectating text');
        break;
      }
      case 'outcome': {
        const text = (r?.text ?? '').toUpperCase();
        const outcome = /VICTORY/.test(text) ? 'Victory' : /DEFEAT/.test(text) ? 'Defeat' : /DRAW/.test(text) ? 'Draw' : undefined;
        if (outcome) {
          this.outcomeUntil = -Infinity;
          if (this.inMatch) this.endMatch(now);
          this.sink.infoUpdate('match_info', 'match_outcome', outcome);
        }
        break;
      }
    }
    this.tick(now);
  }

  /** Call often (every frame). Emits the events whose evidence is complete. */
  tick(now: number): void {
    if (this.o.ocr && now >= this.nextSubtitleAt) {
      this.nextSubtitleAt = now + 1000;
      this.cb.wantCrop?.('subtitle');
    }
    if (this.o.ocr && this.inMatch && now >= this.nextStatusAt) {
      this.nextStatusAt = now + 1000;
      this.cb.wantCrop?.('status');
    }
    // Outside a match, read the map label every few seconds, so the Practice Range is known before the first KO.
    if (this.o.ocr && !this.inMatch && now >= this.nextMapPollAt) {
      this.nextMapPollAt = now + (this.practice ? 5000 : 2500);
      this.cb.wantCrop?.('map');
    }
    for (const k of this.kos) {
      if (k.done) continue;
      // When it may not be you playing, the feed row is what proves the KO is yours: give it time to show and be read.
      const doubt = this.notPlaying(k.t) && !k.assist;
      const waitMs = doubt ? (k.feed ? 2500 : this.o.pairWindowMs + 100) : k.feed && !k.feed.ocrDone ? 2000 : this.o.decideAfterMs;
      const ready = (k.ocrDone && (!k.feed || k.feed.ocrDone) && !(doubt && !k.feed && now - k.t < this.o.pairWindowMs + 100)) || now - k.t >= waitMs;
      if (!ready) continue;
      k.done = true;
      if (k.assist) {
        if (this.notPlaying(k.t)) this.ignore(k.t, 'assist', k.victim);
        else this.emitAssist(k.t, k.victim);
        continue;
      }
      // A trade: the feed row paired with this KO is actually your death. Count both.
      if (k.feed?.ocr && this.sidesOf(k.feed.ocr)?.mine === 'victim') {
        const death = k.feed;
        death.ko = undefined;
        death.done = true;
        this.emitDeath(death.t, this.sidesOf(death.ocr!)?.attacker);
        k.feed = undefined;
        const other = this.feed.find((x) => !x.ko && !x.done && x !== death && Math.abs(x.t - k.t) <= this.o.pairWindowMs);
        if (other) this.pair(k, other);
      }
      if (k.feed) k.feed.done = true;
      const row = k.feed?.ocr;
      if (row && this.foreignRow(row)) {
        // The row next to this KO has someone else's name: it is their KO, shown because you're watching them.
        this.markWatching(k.t, WATCH_MS, 'someone else\'s kill-feed row');
        this.ignore(k.t, 'kill', k.victim);
        continue;
      }
      const mine = !!row && this.sidesOf(row)?.mine === 'attacker';
      if (mine) this.playing(k.t);
      else if (this.notPlaying(k.t)) {
        this.ignore(k.t, 'kill', k.victim);
        continue;
      }
      const victim = k.victim ?? (row ? this.sidesOf(row)?.victim : undefined);
      this.emitKill(k.t, victim);
    }
    for (const f of this.feed) {
      if (f.done || f.ko) continue;
      const settled = now - f.t >= this.o.pairWindowMs + 100 && f.ocrDone;
      if (!settled && now - f.t < this.o.pairWindowMs + this.o.decideAfterMs + 1500) continue;
      f.done = true;
      const sides = f.ocr ? this.sidesOf(f.ocr) : undefined;
      if (sides?.mine === 'attacker') {
        // Same KO as a KO-list name that had no row of its own (e.g. it was paired with a death).
        const k = this.kos.find((x) => !x.feed && !x.assist && Math.abs(x.t - f.t) <= this.o.pairWindowMs);
        if (k) this.pair(k, f);
        else {
          this.playing(f.t);
          this.emitKill(f.t, sides.victim);
        }
      } else if (sides?.mine === 'victim') {
        this.emitDeath(f.t, sides.attacker);
      }
      // Unknown: without your name we can't tell a KO from a death, so nothing is claimed.
    }
    for (const b of this.banners) {
      if (b.done) continue;
      if (!b.count) {
        if (b.ocrDone || now - b.t > 4000) b.done = true;
        continue;
      }
      b.done = true;
      if (this.notPlaying(b.t)) continue;
      // A banner always comes with a KO. If none was seen just before it, the KO was missed.
      if (b.t - this.lastKillAt > 2500 && !this.kos.some((k) => !k.done && Math.abs(k.t - b.t) < 2500)) this.emitKill(b.t, undefined);
    }
    // Forget old evidence.
    const keep = now - 15_000;
    this.kos = this.kos.filter((k) => !k.done || k.t > keep);
    this.feed = this.feed.filter((f) => !f.done || f.t > keep);
    this.banners = this.banners.filter((b) => !b.done || b.t > keep);

    // Match end when the bar has been gone long enough.
    if (this.inMatch && now - this.hudSeenAt >= this.o.matchEndAfterMs) this.endMatch(now);
    // While the bar is gone right after a match, look for VICTORY / DEFEAT once a second.
    if (this.o.ocr && now < this.outcomeUntil && now >= this.nextOutcomeAt) {
      this.nextOutcomeAt = now + 1000;
      this.cb.wantCrop?.('outcome');
    }
    if (this.o.ocr && !this.mapKnown && this.mapRequests.length && now >= this.mapRequests[0]) {
      this.mapRequests.shift();
      this.cb.wantCrop?.('map');
    }
  }

  // ---------- internals ----------

  private pair(k: KoItem, f: FeedItem): void {
    k.feed = f;
    f.ko = k;
  }

  private emitKill(at: number, victim: string | undefined): void {
    if (this.o.strictKills && (!victim || normalizeName(victim).length < 3)) return;
    // You can't KO yourself: a "kill" whose victim is your own name is your death row read a second time
    // (seen on every death in the 2026-11-09 log), and it clipped the death and the spectating after it.
    if (victim && this.isMyName(victim)) {
      this.ignore(at, 'kill', victim, 'your own death');
      return;
    }
    if (victim && this.sameVictimAgain(victim, at)) return;
    this.checkPractice(at);
    this.lastKillAt = at;
    this.kills++;
    this.sink.gameEvent(
      'kill_feed',
      { attacker: this.me, victim: victim || undefined, attacker_is_teammate: true, victim_is_teammate: false },
      at,
    );
    this.sink.gameEvent('kill', this.kills, at);
  }

  /** True when this name was KO'd moments ago: the HUD showed the same KO twice (it moved, or flickered). */
  private sameVictimAgain(victim: string, at: number): boolean {
    this.recentVictims = this.recentVictims.filter((v) => at - v.at < SAME_VICTIM_MS);
    if (normalizeName(victim).length >= 3 && this.recentVictims.some((v) => nameSimilarity(v.name, victim) >= 0.8 || (this.o.strictKills && Math.abs(at - v.at) < 1500 && nameSimilarity(v.name.split(/\s+/).at(-1)!, victim.split(/\s+/).at(-1)!) >= 0.65) || (this.o.strictKills && (normalizeName(v.name).includes(normalizeName(victim)) || normalizeName(victim).includes(normalizeName(v.name)))))) return true;
    this.recentVictims.push({ name: victim, at });
    return false;
  }

  private emitAssist(at: number, victim: string | undefined): void {
    if (victim && this.isMyName(victim)) return this.ignore(at, 'assist', victim, 'your own death');
    this.checkPractice(at);
    this.assists++;
    this.sink.gameEvent('assist', { victim: victim || undefined }, at);
  }

  private emitDeath(at: number, attacker: string | undefined): void {
    this.deadAt = Math.max(this.deadAt, at);
    this.deaths++;
    this.sink.gameEvent('kill_feed', { attacker: attacker || undefined, victim: this.me, attacker_is_teammate: false, victim_is_teammate: true }, at);
    this.sink.gameEvent('death', this.deaths, at);
  }

  /** True when the screen at `t` is probably not your own view: you're dead, spectating or watching a replay. */
  notPlaying(t: number): boolean {
    if (t > this.deadAt + DEATH_GRACE_MS && t < this.deadAt + DEAD_MS) return true;
    return t < this.watchingUntil;
  }

  private markWatching(t: number, ms: number, why: string): void {
    if (t + ms <= this.watchingUntil) return;
    if (this.watchingUntil < t) this.sink.infoUpdate('match_info', 'not_playing', why);
    this.watchingUntil = t + ms;
  }

  /** A KO with your own name on it: you're clearly playing again (respawned, back from spectating). */
  private playing(t: number): void {
    // A KO right as you die (a projectile landing after) is yours too, but it doesn't mean you've respawned.
    if (t > this.deadAt + DEATH_GRACE_MS) this.deadAt = -Infinity;
    if (t >= this.watchingUntil - WATCH_MS) this.watchingUntil = -Infinity;
  }

  private ignore(t: number, what: 'kill' | 'assist', victim: string | undefined, reason = 'not your view (dead, spectating or a replay)'): void {
    this.ignored++;
    this.sink.infoUpdate('match_info', 'ignored_ko', { what, victim, at: t, reason });
  }

  /** True when `text` reads as your own name (or one of its words), allowing for misreads. */
  private isMyName(text: string): boolean {
    const name = this.playerName;
    if (!name || normalizeName(text).length < 3) return false;
    if (nameSimilarity(text, name) >= 0.7) return true;
    const parts = name.split(/\s+/).filter((p) => normalizeName(p).length >= 3);
    return parts.length > 1 && parts.some((p) => nameSimilarity(text, p) >= 0.85);
  }

  /** A feed row with two names and neither of them yours: someone else's row, highlighted because the game is showing their view. */
  private foreignRow(r: OcrResult): boolean {
    const name = this.playerName;
    if (!name) return false;
    const words = nameWords(r.words).filter((w) => w.conf >= 60);
    if (words.length < 2) return false;
    const all = nameWords(r.words);
    const parts = name.split(/\s+/).filter((p) => normalizeName(p).length >= 3);
    // Lenient here: anything a bit like your name means it may be your row, misread.
    if (all.some((w) => nameSimilarity(w.text, name) >= 0.5 || parts.some((p) => nameSimilarity(w.text, p) >= 0.6))) return false;
    const xs = words.map((w) => (w.x0 + w.x1) / 2);
    return Math.max(...xs) - Math.min(...xs) >= 60;
  }

  /** Which side of a feed row is you, from the OCR words and your (known or learned) name. */
  private sidesOf(r: OcrResult): { mine?: 'attacker' | 'victim'; attacker?: string; victim?: string } | undefined {
    const words = nameWords(r.words);
    if (!words.length) return undefined;
    const name = this.playerName;
    if (!name) return undefined;
    // Your name may be several words; score each word against the name and its parts.
    const parts = name.split(/\s+/).filter((p) => normalizeName(p).length >= 2);
    const isMine = (w: OcrWord) => nameSimilarity(w.text, name) >= 0.7 || parts.some((p) => normalizeName(p).length >= 3 && nameSimilarity(w.text, p) >= 0.75);
    const mine = words.filter(isMine);
    const other = words.filter((w) => !isMine(w));
    if (!mine.length) return undefined;
    const mineX = mine.reduce((s, w) => s + (w.x0 + w.x1) / 2, 0) / mine.length;
    const otherText = other.map((w) => w.text).join(' ').trim() || undefined;
    if (!other.length) return { mine: undefined };
    const otherX = other.reduce((s, w) => s + (w.x0 + w.x1) / 2, 0) / other.length;
    return mineX < otherX ? { mine: 'attacker', victim: otherText } : { mine: 'victim', attacker: otherText };
  }

  /** Your name is the word that shows up in (almost) every one of your feed rows. */
  private learnName(r: OcrResult): void {
    if (this.playerName) return;
    const seen = new Set(nameWords(r.words).map((w) => normalizeName(w.text)));
    if (!seen.size) return;
    this.feedRowsRead++;
    for (const w of seen) this.nameVotes.set(w, (this.nameVotes.get(w) ?? 0) + 1);
    if (this.feedRowsRead < 4) return;
    let best = '';
    let votes = 0;
    for (const [w, n] of this.nameVotes) if (n > votes) [best, votes] = [w, n];
    if (votes >= 4 && votes / this.feedRowsRead >= 0.7) {
      // Use the spelling OCR gave for that word.
      const word = r.words.find((w) => normalizeName(w.text) === best)?.text ?? best;
      this.playerName = word;
      this.sink.infoUpdate('game_info', 'player_name', word);
      this.cb.onNameLearned?.(word);
    }
  }

  private onHud(t: number, visible: boolean): void {
    this.hudWindow.push({ t, v: visible });
    while (this.hudWindow.length && this.hudWindow[0].t < t - 3000) this.hudWindow.shift();
    const share = this.hudWindow.filter((h) => h.v).length / this.hudWindow.length;
    const present = this.hudWindow.length >= 3 && share >= 0.4;
    if (present) {
      this.hudSeenAt = t;
      if (!this.hudVerified) {
        this.hudVerified = true;
        this.cb.onHudVerified?.();
      }
      // The label said Practice Range: something that looks like a match bar there doesn't make it a match.
      // A real map name on the label (read every few seconds outside a match) ends that.
      if (!this.inMatch && !this.practiceByLabel) this.startMatch(t);
    } else if (this.inMatch && this.hudLostAt < this.hudSeenAt) {
      // The bar just went away: the match may be over. Check for the result screen for a while.
      this.hudLostAt = t;
      this.outcomeUntil = t + 20_000;
    }
  }

  private startMatch(t: number): void {
    this.inMatch = true;
    this.practice = false;
    this.matchStartAt = t;
    this.kills = 0;
    this.deaths = 0;
    this.mapKnown = false;
    this.sink.gameEvent('match_start', undefined, t);
    if (this.o.ocr) this.mapRequests = [t + 2000, t + 8000, t + 20_000, t + 45_000];
  }

  private endMatch(t: number): void {
    this.inMatch = false;
    this.sink.gameEvent('match_end', undefined, t);
  }

  /** A KO with no match bar on screen is not a real match: the Practice Range (or another mode with no score). */
  private checkPractice(t: number): void {
    if (this.inMatch || this.practice) return;
    this.enterPractice(t, 'no match bar');
  }

  private enterPractice(t: number, why: string): void {
    if (this.practice) return;
    // The label is the strongest sign; without it, a match bar on screen means a real match.
    if (why !== 'map label' && this.inMatch && this.hudSeenAt > t - 10_000) return;
    this.inMatch = false;
    this.practice = true;
    this.kills = 0;
    this.sink.gameEvent('match_start', undefined, t);
    this.sink.infoUpdate('game_info', 'game_type', 'Practice');
  }
}

export function bestMap(text: string): string | undefined {
  const t = normalizeName(text);
  if (t.length < 5) return undefined;
  let best: string | undefined;
  let score = 0;
  for (const m of MAP_NAMES) {
    // The label may show only the second half ("Hall of Djalia") or be cut off.
    for (const cand of [m, m.split(':').pop() ?? m]) {
      const c = normalizeName(cand);
      if (c.length < 5) continue;
      const s = t.includes(c) ? 1 : nameSimilarity(t.slice(0, c.length + 4), c);
      if (s > score) [best, score] = [m, s];
    }
  }
  return score >= 0.72 ? best : undefined;
}
