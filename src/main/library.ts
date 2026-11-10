// The clip Library: an index over every clip's JSON sidecar, with search, filters and ranking.
// Sidecars stay the source of truth. The index lives in memory and rescans only files that changed,
// so it stays fast with thousands of clips and needs no native database module.

import fs from 'node:fs';
import path from 'node:path';
import type { ClipSidecar } from '../shared/types';
import { heroOf } from './studio/clip-rules';

export type ClipSort = 'new' | 'score' | 'kills' | 'rating';

export interface ClipQuery {
  /** Free text: matched against hero, map, mode, game type, tags, victim heroes and the AI summary. */
  text?: string;
  hero?: string;
  map?: string;
  gameType?: string;
  /** Every tag listed must be on the clip. */
  tags?: string[];
  minKills?: number;
  minRating?: number;
  trigger?: 'auto' | 'manual';
  /** Epoch ms bounds on createdAt. */
  since?: number;
  until?: number;
  sort?: ClipSort;
  limit?: number;
  offset?: number;
}

export interface ClipQueryResult {
  items: ClipSidecar[];
  /** Matches before limit/offset. */
  total: number;
}

export interface Facet {
  value: string;
  count: number;
}

export interface LibraryFacets {
  heroes: Facet[];
  maps: Facet[];
  gameTypes: Facet[];
  tags: Facet[];
  total: number;
}

export const killCount = (c: ClipSidecar): number => c.events.filter((e) => e.type === 'kill').length;

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();

function haystack(c: ClipSidecar): string {
  const victims = c.events.map((e) => e.victimHero ?? '').join(' ');
  return [c.hero, c.match.map, c.match.gameMode, c.match.gameType, c.endedMatch, victims, c.ai?.summary, ...c.tags].map(norm).join(' ');
}

/** Filter, sort and page a list of clips. Pure, so the UI and the Studio get the same answer. */
export function queryClips(clips: ClipSidecar[], q: ClipQuery = {}): ClipQueryResult {
  const words = norm(q.text).split(/\s+/).filter(Boolean);
  const tags = (q.tags ?? []).map(norm).filter(Boolean);
  const matches = clips.filter((c) => {
    if (q.hero && norm(c.hero) !== norm(q.hero)) return false;
    if (q.map && norm(c.match.map) !== norm(q.map)) return false;
    if (q.gameType && norm(c.match.gameType) !== norm(q.gameType)) return false;
    if (q.trigger && c.trigger !== q.trigger) return false;
    if (q.minKills && killCount(c) < q.minKills) return false;
    if (q.minRating && (c.rating ?? 0) < q.minRating) return false;
    if (q.since && c.createdAt < q.since) return false;
    if (q.until && c.createdAt > q.until) return false;
    if (tags.length) {
      const have = new Set(c.tags.map(norm));
      if (!tags.every((t) => have.has(t))) return false;
    }
    if (words.length) {
      const h = haystack(c);
      if (!words.every((w) => h.includes(w))) return false;
    }
    return true;
  });
  const sort = q.sort ?? 'new';
  const key: Record<ClipSort, (c: ClipSidecar) => number> = {
    new: (c) => c.createdAt,
    score: (c) => c.score,
    kills: (c) => killCount(c),
    rating: (c) => c.rating ?? 0,
  };
  // Ties fall back to score, then newest, so ordering is stable and sensible.
  matches.sort((a, b) => key[sort](b) - key[sort](a) || b.score - a.score || b.createdAt - a.createdAt);
  const offset = Math.max(0, q.offset ?? 0);
  const limit = Math.max(1, q.limit ?? 200);
  return { items: matches.slice(offset, offset + limit), total: matches.length };
}

function count(values: Array<string | undefined>): Facet[] {
  const m = new Map<string, number>();
  for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m].map(([value, n]) => ({ value, count: n })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** What the filter dropdowns can offer, with how many clips each has. */
export function facetsOf(clips: ClipSidecar[]): LibraryFacets {
  return {
    heroes: count(clips.map((c) => c.hero)),
    maps: count(clips.map((c) => c.match.map)),
    gameTypes: count(clips.map((c) => c.match.gameType)),
    tags: count(clips.flatMap((c) => c.tags.filter((t) => !t.includes(':')))),
    total: clips.length,
  };
}

interface Entry {
  mtimeMs: number;
  clip: ClipSidecar;
}

function readSidecar(file: string): ClipSidecar | undefined {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) as ClipSidecar;
    if (!validSidecar(c)) return undefined;
    // Older clips kept the raw text read off the screen ("CBSBEADPOOL"); show the real hero name.
    const hero = heroOf(c);
    if (hero) c.hero = hero;
    return c;
  } catch {
    return undefined; // broken or half-written sidecar
  }
}

/** Files may be hand-edited or partially recovered. Never index an unsafe shape. */
function validSidecar(c: any): c is ClipSidecar {
  const obj = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const num = (v: any) => typeof v === 'number' && Number.isFinite(v);
  const text = (v: any) => v === undefined || typeof v === 'string';
  if (!obj(c) || c.version !== 1 || typeof c.videoFile !== 'string' || !c.videoFile || typeof c.id !== 'string') return false;
  if (![c.createdAt, c.startTimeEpoch, c.durationMs, c.score].every(num) || !['auto', 'manual'].includes(c.trigger)) return false;
  if (!obj(c.match) || ![c.hero, c.endedMatch, c.match.map, c.match.gameMode, c.match.gameType, c.match.matchId, c.match.outcome].every(text)) return false;
  if (!Array.isArray(c.events) || !c.events.every((e: any) => obj(e) && ['kill', 'assist', 'death'].includes(e.type) && num(e.at) && [e.victim, e.victimHero, e.myHero].every(text))) return false;
  if (!Array.isArray(c.tags) || !c.tags.every((v: any) => typeof v === 'string')) return false;
  if (!obj(c.video) || ![c.video.width, c.video.height, c.video.fps].every(num)) return false;
  if (!Array.isArray(c.audioTracks) || !c.audioTracks.every((a: any) => obj(a) && Number.isInteger(a.index) && a.index >= 0 && ['game', 'mic'].includes(a.label))) return false;
  if (c.rating !== undefined && !num(c.rating)) return false;
  if (c.ai !== undefined && (!obj(c.ai) || !text(c.ai.summary) || !Array.isArray(c.ai.tags) || !c.ai.tags.every((v: any) => typeof v === 'string'))) return false;
  return true;
}

export class Library {
  private entries = new Map<string, Entry>();

  constructor(private getClipsFolder: () => string) {}

  /** Rescan the clips folder. Only sidecars that are new or changed since the last scan are read. */
  refresh(): void {
    const seen = new Set<string>();
    const walk = (dir: string) => {
      let list: fs.Dirent[];
      try {
        list = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of list) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.json')) {
          seen.add(p);
          let mtimeMs: number;
          try {
            mtimeMs = fs.statSync(p).mtimeMs;
          } catch {
            continue;
          }
          const old = this.entries.get(p);
          if (old && old.mtimeMs === mtimeMs) continue;
          const clip = readSidecar(p);
          if (clip) this.entries.set(p, { mtimeMs, clip });
          else this.entries.delete(p);
        }
      }
    };
    walk(this.getClipsFolder());
    for (const p of [...this.entries.keys()]) if (!seen.has(p)) this.entries.delete(p);
  }

  /** All indexed clips, unsorted. Call refresh() first if files may have changed on disk. */
  all(): ClipSidecar[] {
    return [...this.entries.values()].map((e) => e.clip);
  }

  query(q: ClipQuery = {}): ClipQueryResult {
    this.refresh();
    return queryClips(this.all(), q);
  }

  facets(): LibraryFacets {
    this.refresh();
    return facetsOf(this.all());
  }
}
