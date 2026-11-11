// Multi-kills the clipper split across two clips. Before the streak fix (PR #36) a triple could be saved
// as one clip with two kills and a second clip, a few seconds later, with the third. Reading the kill feed
// gives each clip's own kills; laid on the real clock they show the streak again. The clips of one
// streak are joined end to end (the second picks up exactly where the first stops), so the reel shows
// the whole multi-kill, and the streak's kill count is what "doubles and triples only" checks.
// Pure functions, no I/O.

import type { ReelClip } from '../../shared/studio';

/** Your kills this close together (seconds, real time) are one streak: the game's multi-kill window. */
export const STREAK_GAP = 10;

export interface TimedClip {
  clip: ReelClip;
  /** Real time the clip's footage starts, epoch seconds. */
  start: number;
}

const killsAt = (t: TimedClip) => t.clip.hits.filter((h) => h >= t.clip.in && h <= t.clip.out).map((h) => t.start + h);

/**
 * Groups clips whose kills chain within STREAK_GAP of each other, and joins each group into a run of
 * clips that plays as one: each clip after the first starts where the one before it ends (real time),
 * so nothing is shown twice. Every clip of a group gets `streak` with the group's total kill count.
 * A clip whose kills all show in an earlier clip of the group (the footage overlaps) is dropped.
 * Returns the clips in their input order, groups kept together at the first member's place.
 */
export function joinStreaks(items: TimedClip[], gap = STREAK_GAP): ReelClip[] {
  const sorted = items.filter((t) => Number.isFinite(t.start)).sort((a, b) => a.start - b.start);
  const groups: TimedClip[][] = [];
  let lastKill = -Infinity;
  for (const t of sorted) {
    const ks = killsAt(t);
    // A clip without a kill of yours is left as it is and doesn't break a streak around it.
    if (!ks.length) continue;
    const g = groups[groups.length - 1];
    if (g && ks[0] - lastKill <= gap) g.push(t);
    else groups.push([t]);
    if (ks.length) lastKill = Math.max(lastKill, ks[ks.length - 1]);
  }
  const joined = new Map<ReelClip, ReelClip[]>();
  for (const g of groups) {
    if (g.length < 2) {
      joined.set(g[0].clip, [g[0].clip]);
      continue;
    }
    const run: ReelClip[] = [];
    const seen: number[] = [];
    let end = -Infinity; // real time the run has shown up to
    for (const t of g) {
      const ks = killsAt(t).filter((k) => !seen.some((s) => Math.abs(s - k) < 0.6));
      if (!ks.length) continue; // all its kills already play in the clip before
      const c = { ...t.clip };
      if (run.length) {
        const prev = run[run.length - 1];
        // The previous clip plays up to its end or this clip's first new kill (with build-up), whichever is first;
        // this one picks up from there.
        const handoff = Math.min(end, ks[0] - 1);
        const prevStart = g.find((x) => x.clip.uid === prev.uid)!.start;
        prev.out = Math.min(prev.out, Math.max((prev.hits.filter((h) => h <= prev.out).at(-1) ?? prev.in) + 0.3, handoff - prevStart));
        end = prevStart + prev.out;
        c.in = Math.max(c.in, end - t.start);
      }
      c.hits = c.hits.filter((h) => h >= c.in && h <= c.out && !seen.some((s) => Math.abs(s - (t.start + h)) < 0.6));
      c.kills = c.hits.length;
      seen.push(...ks);
      end = t.start + c.out;
      run.push(c);
    }
    const total = seen.length;
    const id = run[0]?.uid;
    run.forEach((c, part) => (c.streak = { id, kills: total, part }));
    if (run.length === 1) delete run[0].streak;
    joined.set(g[0].clip, run);
    for (const t of g.slice(1)) joined.set(t.clip, []);
  }
  const out: ReelClip[] = [];
  for (const t of items) out.push(...(joined.get(t.clip) ?? [t.clip]));
  return out;
}

/** Kills that count for a clip rule like "doubles or better": the whole streak's when the clip is part of one. */
export const streakKills = (c: { kills: number; streak?: { kills: number } }) => Math.max(c.kills, c.streak?.kills ?? 0);

/** Keeps the clips of each streak next to each other and in order, wherever the first one lands. */
export function keepStreaksTogether(clips: ReelClip[]): ReelClip[] {
  const out: ReelClip[] = [];
  const placed = new Set<ReelClip>();
  for (const c of clips) {
    if (placed.has(c)) continue;
    const members = c.streak ? streakMembers(clips, c.streak.id) : [c];
    for (const m of members) {
      placed.add(m);
      out.push(m);
    }
  }
  return out;
}

/** The clips of one streak, in the order they happened (whatever order the list has them in). */
export function streakMembers<T extends { streak?: { id: string; part?: number } }>(clips: T[], id: string): T[] {
  return clips.filter((x) => x.streak?.id === id).sort((a, b) => (a.streak!.part ?? 0) - (b.streak!.part ?? 0));
}
