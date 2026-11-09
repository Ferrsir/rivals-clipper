// Makes a reel actually hit the length that was asked for. The AI picks clips from text facts and
// often under-shoots ("make it 30 seconds" came back 14 s), so after every AI plan or revision the
// Studio measures the real beat-synced timeline and pulls in more kill clips from the library, or
// drops the weakest ones, until the reel is within a second or two of the target.

import fs from 'node:fs';
import type { ClipSidecar } from '../../shared/types';
import type { MusicAnalysis, ReelClip, ReelProject } from '../../shared/studio';
import { getFormat } from './formats';
import { orderClips, plan } from './planner';
import { reelClipFromSidecar } from './projects';

/** "about 30 seconds", "30s", "a 45-second reel", "1 minute", "half a minute" -> seconds. */
export function requestedSeconds(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();
  if (/\bhalf (?:a )?minute\b/.test(t)) return 30;
  const range = t.match(/(\d{1,3}(?:\.\d+)?)\s*(?:-|–|to)\s*(\d{1,3}(?:\.\d+)?)\s*-?\s*(?:s|secs?|seconds?)\b/);
  if (range) return clampSeconds(Number(range[2]));
  const sec = t.match(/(\d{1,3}(?:\.\d+)?)\s*-?\s*(?:s|secs?|seconds?)\b/);
  if (sec) return clampSeconds(Number(sec[1]));
  const min = t.match(/(\d(?:\.\d+)?|a|one)\s*-?\s*(?:min|mins|minutes?)\b/);
  if (min) return clampSeconds((min[1] === 'a' || min[1] === 'one' ? 1 : Number(min[1])) * 60);
  return undefined;
}

function clampSeconds(v: number): number | undefined {
  return Number.isFinite(v) && v >= 5 && v <= 180 ? v : undefined;
}

const killCount = (c: ClipSidecar) => c.events.filter((e) => e.type === 'kill').length;

export function duration(project: ReelProject, analysis: MusicAnalysis | null): number {
  const fmt = getFormat(project.format);
  return plan({
    clips: orderClips(project.clips, project.order),
    style: project.style,
    fps: project.fps,
    analysis: project.music ? analysis : null,
    musicStart: project.music?.start ?? 'auto',
    heroUid: project.heroUid,
    intro: project.intro,
    captions: project.captions,
    maxSeconds: fmt.maxSeconds,
  }).duration;
}

export interface FitResult {
  project: ReelProject;
  added: string[];
  removed: string[];
  seconds: number;
}

/**
 * Add the best unused kill clips (same heroes first) until the reel reaches the target,
 * or remove the weakest clips (never the closing one) until it fits under it.
 * Clips the user added by hand (external media) are never removed.
 */
export function fitToTarget(project: ReelProject, library: ClipSidecar[], analysis: MusicAnalysis | null, opts: { maxAdd?: number; prepare?: (clip: ReelClip) => ReelClip | null } = {}): FitResult {
  const target = project.targetSeconds;
  let p: ReelProject = { ...project, clips: [...project.clips] };
  let seconds = duration(p, analysis);
  const added: string[] = [];
  const removed: string[] = [];
  if (!target || !p.clips.length) return { project: p, added, removed, seconds };
  const under = Math.max(1.5, target * 0.07);
  const over = Math.max(0.5, target * 0.03);

  if (seconds < target - under) {
    const used = new Set(p.clips.map((c) => c.videoFile));
    const heroes = new Map<string, number>();
    for (const c of p.clips) if (c.hero) heroes.set(c.hero, (heroes.get(c.hero) ?? 0) + 1);
    const pool = library
      .filter((c) => killCount(c) > 0 && !used.has(c.videoFile) && fs.existsSync(c.videoFile))
      .sort((a, b) => (heroes.get(b.hero ?? '') ?? 0) - (heroes.get(a.hero ?? '') ?? 0) || (b.rating ?? 0) - (a.rating ?? 0) || b.score - a.score);
    const maxAdd = opts.maxAdd ?? 20;
    // Prepare first, then go best-first by what each clip really holds (its own kills, its trim),
    // keeping your star ratings and the reel's heroes ahead.
    const ready = pool
      .map((source) => ({ source, clip: opts.prepare ? opts.prepare(reelClipFromSidecar(source)) : reelClipFromSidecar(source) }))
      .filter((x): x is { source: ClipSidecar; clip: ReelClip } => !!x.clip)
      .sort((a, b) => (heroes.get(b.clip.hero ?? '') ?? 0) - (heroes.get(a.clip.hero ?? '') ?? 0) || (b.source.rating ?? 0) - (a.source.rating ?? 0) || b.clip.score - a.clip.score);
    for (const { source, clip } of ready) {
      if (added.length >= maxAdd || seconds >= target - under) break;
      // Keep the closing clip (the best play, on the drop) last.
      const clips = [...p.clips];
      clips.splice(Math.max(0, clips.length - 1), 0, clip);
      const trial = { ...p, clips };
      const d = duration(trial, analysis);
      if (d > target + over) continue;
      p = trial;
      seconds = d;
      added.push(source.id);
    }
  }

  // Still short (not enough clips, or the next one would overshoot): give every clip a little more
  // build-up before its first kill, using footage the clips already have, until the reel reaches the target.
  for (let step = 1; seconds < target - 0.6 && step <= 8; step++) {
    const [lo, hi] = project.style.leadIn;
    const style = { ...p.style, leadIn: [Math.min(lo + 0.25 * step, 4), Math.min(hi + 0.3 * step, 5.5)] as [number, number] };
    const trial = { ...p, style };
    const d = duration(trial, analysis);
    if (d > target + over) break;
    if (d > seconds) {
      p = trial;
      seconds = d;
    }
  }

  for (let guard = 0; seconds > target + over && p.clips.length > 1 && guard < 40; guard++) {
    const last = p.clips[p.clips.length - 1];
    const candidates = p.clips.filter((c) => c !== last && !c.external);
    if (!candidates.length) break;
    const weakest = candidates.reduce((a, b) => (b.score < a.score ? b : a));
    p = { ...p, clips: p.clips.filter((c) => c !== weakest) };
    seconds = duration(p, analysis);
    removed.push(weakest.clipId);
  }
  return { project: p, added, removed, seconds };
}

export function describeFit(r: FitResult, target?: number): string {
  if (!target) return '';
  const parts: string[] = [];
  if (r.added.length) parts.push(`added ${r.added.length} more kill clip${r.added.length === 1 ? '' : 's'}`);
  if (r.removed.length) parts.push(`dropped ${r.removed.length} weaker clip${r.removed.length === 1 ? '' : 's'}`);
  const len = `${r.seconds.toFixed(1)} s for your ${target} s target`;
  return parts.length ? `${parts.join(' and ')} to reach ${len}.` : `Length: ${len}.`;
}

export type { ReelClip };
