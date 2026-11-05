// Action moments in footage that has no kill markers: your own clips from any game, anime or film.
// A moment is a loud hit (a spike in the sound) and, when it lines up, a hard visual change (a flash,
// an impact frame, a cut). The planner treats moments the way it treats kills, so they land on the
// beat, and long sources are cut into short excerpts around their strongest moments.

import { execFile } from 'node:child_process';
import type { MediaAsset, Moment, ReelClip, ReelProject } from '../../shared/studio';
import { ANALYSIS_RATE, computeFeatures } from './beats';
import { newId } from './projects';

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Loudness spikes: sharp onsets on top of loud frames, at least `gap` seconds apart. */
export function audioMoments(samples: Float32Array, sr = ANALYSIS_RATE, gap = 0.9): Moment[] {
  if (samples.length < sr * 0.5) return [];
  const f = computeFeatures(samples, sr);
  const n = f.onset.length;
  let mean = 0;
  for (const v of f.rms) mean += v;
  mean /= Math.max(1, n);
  let sd = 0;
  for (const v of f.rms) sd += (v - mean) ** 2;
  sd = Math.sqrt(sd / Math.max(1, n)) || 1;
  const score = new Float64Array(n);
  for (let i = 0; i < n; i++) score[i] = f.onset[i] * 0.7 + Math.max(0, (f.rms[i] - mean) / sd) * 0.6 + f.lowOnset[i] * 0.3;
  const half = Math.max(1, Math.round((gap * f.frameRate) / 2));
  const peaks: Moment[] = [];
  for (let i = 1; i < n - 1; i++) {
    const v = score[i];
    if (v < 1.6) continue;
    let top = true;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half) && top; j++) if (score[j] > v || (score[j] === v && j < i)) top = false;
    if (top) peaks.push({ t: r3(i / f.frameRate), s: Math.round(v * 100) / 100 });
  }
  return peaks;
}

/** Times of hard visual changes from ffmpeg's scene score (`showinfo` lines). */
export function parseSceneTimes(stderr: string): number[] {
  const out: number[] = [];
  for (const m of stderr.matchAll(/pts_time:\s*(\d+(?:\.\d+)?)/g)) out.push(r3(Number(m[1])));
  return out;
}

/** Combine sound spikes with visual changes; keep the strongest, sorted by time. */
export function mergeMoments(audio: Moment[], scenes: number[], durationSec: number, max = 60): Moment[] {
  const list = audio.map((m) => ({ ...m }));
  for (const t of scenes) {
    const near = list.find((m) => Math.abs(m.t - t) <= 0.25);
    if (near) near.s = Math.round((near.s + 1) * 100) / 100;
    else list.push({ t, s: 1.2 });
  }
  const inside = list.filter((m) => m.t > 0.3 && m.t < durationSec - 0.2);
  const kept: Moment[] = [];
  for (const m of inside.sort((a, b) => b.s - a.s)) {
    if (kept.length >= max) break;
    if (kept.every((k) => Math.abs(k.t - m.t) >= 0.6)) kept.push(m);
  }
  return kept.sort((a, b) => a.t - b.t);
}

/** Mono float PCM of a video's sound. */
function decodeAudio(ffmpeg: string, file: string, rate: number, signal?: AbortSignal): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024, windowsHide: true, signal }, (err, stdout) => {
      if (err) return reject(err);
      const buf = stdout as Buffer;
      resolve(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + Math.floor(buf.length / 4) * 4)));
    });
  });
}

function sceneTimes(ffmpeg: string, file: string, signal?: AbortSignal): Promise<number[]> {
  return new Promise((resolve) => {
    execFile(
      ffmpeg,
      ['-hide_banner', '-nostdin', '-i', file, '-an', '-vf', "scale=320:-2,select='gt(scene\\,0.32)',showinfo", '-f', 'null', '-'],
      { timeout: 180_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, signal },
      (_e, _out, err) => resolve(parseSceneTimes(String(err ?? ''))),
    );
  });
}

/** Find the action in a video you dropped in. Never throws: no moments just means plain beat cuts. */
export async function detectMoments(ffmpeg: string, file: string, durationSec: number, hasAudio: boolean, signal?: AbortSignal): Promise<Moment[]> {
  const [samples, scenes] = await Promise.all([
    hasAudio ? decodeAudio(ffmpeg, file, ANALYSIS_RATE, signal).catch(() => new Float32Array(0)) : Promise.resolve(new Float32Array(0)),
    sceneTimes(ffmpeg, file, signal),
  ]);
  return mergeMoments(audioMoments(samples), scenes, durationSec, Math.min(80, Math.max(6, Math.round(durationSec / 1.5))));
}

export interface Excerpt {
  in: number;
  out: number;
  hits: number[];
  strength: number;
}

/**
 * Short windows around the strongest moments, enough to fill about `seconds` of reel, kept in story
 * order. Moments close together share one window, so a flurry of hits stays one excerpt.
 */
export function pickExcerpts(moments: Moment[], durationSec: number, seconds: number, opts: { lead?: number; tail?: number; join?: number; maxLen?: number } = {}): Excerpt[] {
  const lead = opts.lead ?? 1.4;
  const tail = opts.tail ?? 0.5;
  const join = opts.join ?? 1.6;
  const maxLen = opts.maxLen ?? 6;
  if (durationSec <= seconds + 1 || !moments.length) return [{ in: 0, out: durationSec, hits: moments.map((m) => m.t), strength: moments.reduce((a, m) => a + m.s, 0) }];
  // Group moments into flurries.
  const groups: Moment[][] = [];
  for (const m of [...moments].sort((a, b) => a.t - b.t)) {
    const g = groups[groups.length - 1];
    if (g && m.t - g[g.length - 1].t <= join && m.t - g[0].t <= maxLen - lead - tail) g.push(m);
    else groups.push([m]);
  }
  const windows: Excerpt[] = groups.map((g) => {
    const a = Math.max(0, g[0].t - lead);
    const b = Math.min(durationSec, g[g.length - 1].t + tail);
    return { in: r3(a), out: r3(b), hits: g.map((m) => m.t), strength: g.reduce((s, m) => s + m.s, 0) };
  });
  const chosen: Excerpt[] = [];
  let total = 0;
  for (const w of [...windows].sort((a, b) => b.strength - a.strength)) {
    if (total >= seconds) break;
    if (chosen.some((c) => w.in < c.out && w.out > c.in)) continue;
    chosen.push(w);
    total += w.out - w.in;
  }
  return chosen.sort((a, b) => a.in - b.in);
}

/** Your video as reel clips: one per excerpt, each with its moments as hits. */
export function excerptClips(base: ReelClip, asset: MediaAsset, seconds: number): ReelClip[] {
  const ex = pickExcerpts(asset.moments ?? [], base.durationSec, seconds);
  return ex.map((e, i) => ({ ...base, uid: i === 0 ? base.uid : newId(), in: e.in, out: e.out, hits: e.hits, score: Math.round(e.strength * 10) / 10 }));
}

/**
 * A long video of yours that the plan uses whole becomes excerpts around its best action, sharing out
 * the target length. Pictures and subtitles placed on it are copied onto each excerpt (they are in
 * source seconds, so each shows only where its moment survives).
 */
export function expandOwnFootage(project: ReelProject, seconds: number): { project: ReelProject; expanded: number } {
  const assets = new Map((project.assets ?? []).map((a) => [`asset:${a.id}`, a]));
  const whole = project.clips.filter((c) => c.external && c.in <= 0.05 && c.out >= c.durationSec - 0.05 && c.durationSec > Math.max(8, seconds / Math.max(1, project.clips.length) + 2) && assets.get(c.clipId)?.moments?.length);
  if (!whole.length) return { project, expanded: 0 };
  const share = seconds / project.clips.length;
  const clips: ReelClip[] = [];
  const copies = new Map<string, string[]>();
  for (const c of project.clips) {
    if (!whole.includes(c)) {
      clips.push(c);
      continue;
    }
    const parts = excerptClips(c, assets.get(c.clipId)!, share);
    copies.set(c.uid, parts.map((p) => p.uid));
    clips.push(...parts);
  }
  const spread = <T extends { clipUid: string }>(list: T[] | undefined) => (list ?? []).flatMap((x) => (copies.get(x.clipUid) ?? [x.clipUid]).map((clipUid) => ({ ...x, clipUid })));
  const overlays = spread(project.overlays).map((o, i, all) => (all.findIndex((p) => p.id === o.id) === i ? o : { ...o, id: newId() }));
  return { project: { ...project, clips, overlays, subtitles: spread(project.subtitles) }, expanded: whole.length };
}
