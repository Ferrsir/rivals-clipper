// Keeps a live picture of the current match from Overwolf GEP info updates and events.
// Field names follow https://dev.overwolf.com/ow-electron/live-game-data-gep/supported-games/marvel-rivals
// GEP often delivers nested values as JSON strings, so everything goes through parseMaybeJson.

import type { ClipEvent, HeroRole, MatchContext } from '../shared/types';
import { canonicalHero } from './studio/clip-rules';

export interface RosterEntry {
  name?: string;
  uid?: string;
  character_name?: string;
  character_id?: string | number;
  team?: string | number;
  is_teammate?: boolean;
  is_local?: boolean;
  is_alive?: boolean;
  kills?: number;
  deaths?: number;
  assists?: number;
  ult_charge?: number;
}

export interface KillFeedEntry {
  attacker?: string;
  attacker_character_name?: string;
  attacker_is_teammate?: boolean;
  victim?: string;
  victim_character_name?: string;
  victim_is_teammate?: boolean;
}

export function parseMaybeJson<T = unknown>(value: unknown): T | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return value as unknown as T;
  }
}

function toBool(v: unknown): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return String(v).toLowerCase() === 'true' || v === '1';
}

function toNum(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeRoster(raw: Record<string, unknown>): RosterEntry {
  return {
    name: raw.name as string | undefined,
    uid: raw.uid as string | undefined,
    character_name: raw.character_name as string | undefined,
    character_id: raw.character_id as string | undefined,
    team: raw.team as string | undefined,
    is_teammate: toBool(raw.is_teammate),
    is_local: toBool(raw.is_local),
    is_alive: toBool(raw.is_alive),
    kills: toNum(raw.kills),
    deaths: toNum(raw.deaths),
    assists: toNum(raw.assists),
    ult_charge: toNum(raw.ult_charge),
  };
}

/** Starting list of Strategists (healers). Roles learned from the hero-select screen are added on top. */
export const DEFAULT_HERO_ROLES: Record<string, HeroRole> = {
  'Adam Warlock': 'Strategist',
  'Cloak & Dagger': 'Strategist',
  'Invisible Woman': 'Strategist',
  'Jeff the Land Shark': 'Strategist',
  Loki: 'Strategist',
  'Luna Snow': 'Strategist',
  Mantis: 'Strategist',
  'Rocket Raccoon': 'Strategist',
  Ultron: 'Strategist',
};

/** True for the Practice Range / training modes, where auto-clips are off by default. */
export function isPracticeMode(ctx: MatchContext): boolean {
  if (ctx.gameType && /practice/i.test(ctx.gameType)) return true;
  return [ctx.gameMode, ctx.map].some((v) => !!v && /practice|training|tutorial/i.test(v));
}

export class MatchState {
  localName?: string;
  private detectedHero?: string;
  roster = new Map<number, RosterEntry>();
  context: MatchContext = {};
  heroRoles: Record<string, HeroRole>;
  /** History of the local player's ult charge: [epochMs, charge]. Kept short. */
  private ultHistory: Array<[number, number]> = [];
  /** Recent kill-feed lines so a `kill` event can be matched to its victim. */
  private recentFeed: Array<{ at: number; entry: KillFeedEntry }> = [];
  /** When you last died (GEP `death`). */
  private lastDeathAt = -Infinity;

  constructor(heroRoles: Record<string, HeroRole> = {}) {
    this.heroRoles = { ...DEFAULT_HERO_ROLES, ...heroRoles };
  }

  get local(): RosterEntry | undefined {
    for (const r of this.roster.values()) if (r.is_local) return r;
    if (this.localName) for (const r of this.roster.values()) if (r.name === this.localName) return r;
    return undefined;
  }

  get myHero(): string | undefined {
    return this.local?.character_name ?? this.detectedHero;
  }

  teammatesAlive(): number | undefined {
    const mates = [...this.roster.values()].filter((r) => r.is_teammate || r.is_local);
    if (!mates.length || mates.every((r) => r.is_alive === undefined)) return undefined;
    return mates.filter((r) => r.is_alive !== false).length;
  }

  enemiesAlive(): number | undefined {
    const enemies = [...this.roster.values()].filter((r) => r.is_teammate === false && !r.is_local);
    if (!enemies.length || enemies.every((r) => r.is_alive === undefined)) return undefined;
    return enemies.filter((r) => r.is_alive !== false).length;
  }

  roleOf(hero?: string): HeroRole | undefined {
    if (!hero) return undefined;
    return this.heroRoles[hero] ?? 'Unknown';
  }

  /** Returns true when a new hero role was learned (so the caller can save it). */
  onInfoUpdate(feature: string, key: string, value: unknown, now: number): boolean {
    if (feature === 'game_info' && key === 'player_name') {
      this.localName = String(value);
      return false;
    }
    if (key.startsWith('roster_')) {
      const idx = Number(key.slice('roster_'.length));
      const parsed = parseMaybeJson<Record<string, unknown>>(value);
      if (!parsed || typeof parsed !== 'object') {
        this.roster.delete(idx);
        return false;
      }
      const entry = normalizeRoster(parsed);
      this.roster.set(idx, entry);
      if (entry.is_local && entry.ult_charge !== undefined) this.pushUlt(now, entry.ult_charge);
      return false;
    }
    switch (key) {
      case 'local_hero':
        // Screen text is often misread ("CBSBEADPOOL"): keep only a real hero name.
        if (typeof value !== 'string') this.detectedHero = undefined;
        else this.detectedHero = canonicalHero(value) ?? this.detectedHero;
        return false;
      case 'match_id':
        this.context.matchId = String(value);
        return false;
      case 'game_type':
        this.context.gameType = String(value);
        return false;
      case 'game_mode':
        this.context.gameMode = String(value);
        return false;
      case 'map':
        this.context.map = String(value);
        return false;
      case 'match_outcome':
        this.context.outcome = String(value) as MatchContext['outcome'];
        return false;
      case 'hovered_character':
      case 'selected_character': {
        const c = parseMaybeJson<{ character_name?: string; role?: string }>(value);
        if (c?.character_name && c.role && this.heroRoles[c.character_name] !== c.role) {
          this.heroRoles[c.character_name] = c.role as HeroRole;
          return true;
        }
        return false;
      }
    }
    return false;
  }

  onDeath(now: number): void {
    this.lastDeathAt = now;
  }

  /**
   * Why a kill/assist at `now` can't be yours, from what Overwolf says about the players, or undefined.
   * The screen detector does its own check (fusion.ts), and sends no roster, so this never blocks it.
   */
  notPlaying(now: number): string | undefined {
    const players = [...this.roster.values()];
    // The roster marks who you are. A full roster with nobody marked as you: spectating or a replay.
    if (players.length >= 2 && players.some((r) => r.is_local !== undefined) && !players.some((r) => r.is_local)) return 'spectating';
    // Dead for more than a moment: the camera is following someone else. (A KO right as you die still counts.)
    if (this.local?.is_alive === false && now - this.lastDeathAt > 1500) return 'dead';
    return undefined;
  }

  onMatchStart(): void {
    this.lastDeathAt = -Infinity;
    this.context = { round: 0 };
    this.ultHistory = [];
    this.recentFeed = [];
  }

  onRoundStart(): void {
    this.context.round = (this.context.round ?? 0) + 1;
  }

  onKillFeed(value: unknown, now: number): void {
    const entry = parseMaybeJson<KillFeedEntry>(value);
    if (!entry || typeof entry !== 'object') return;
    this.recentFeed.push({ at: now, entry: { ...entry, attacker_is_teammate: toBool(entry.attacker_is_teammate), victim_is_teammate: toBool(entry.victim_is_teammate) } });
    this.recentFeed = this.recentFeed.filter((f) => now - f.at < 10_000);
  }

  /** Build a ClipEvent for one of your kills, pulling the victim from the kill feed. */
  describeKill(total: number | undefined, now: number): ClipEvent {
    const me = this.localName ?? this.local?.name;
    const match = [...this.recentFeed]
      .reverse()
      .find((f) => Math.abs(now - f.at) < 1500 && f.entry.attacker !== undefined && f.entry.attacker === me);
    if (match) this.recentFeed = this.recentFeed.filter((f) => f !== match);
    const victimHero = match?.entry.victim_character_name;
    return {
      type: 'kill',
      at: now,
      total,
      victim: match?.entry.victim,
      victimHero,
      victimRole: this.roleOf(victimHero),
      myHero: this.myHero,
      teammatesAlive: this.teammatesAlive(),
      enemiesAlive: this.enemiesAlive(),
    };
  }

  /** True when your ult was ~full and then dropped within `windowMs` before `at`. */
  ultUsedBefore(at: number, windowMs = 10_000): boolean {
    const hist = this.ultHistory.filter(([t]) => t <= at && at - t <= windowMs + 5_000);
    for (let i = 1; i < hist.length; i++) {
      const [, prev] = hist[i - 1];
      const [t, cur] = hist[i];
      if (prev >= 99 && cur < prev - 50 && at - t <= windowMs) return true;
    }
    return false;
  }

  private pushUlt(now: number, charge: number): void {
    const last = this.ultHistory[this.ultHistory.length - 1];
    if (last && last[1] === charge) return;
    this.ultHistory.push([now, charge]);
    this.ultHistory = this.ultHistory.filter(([t]) => now - t < 60_000);
  }
}
