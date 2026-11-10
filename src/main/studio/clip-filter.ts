// Rejects clips whose footage isn't gameplay, so the Studio never picks them on its own: the Tab
// scoreboard (whole screen darkened and grey, measured on Ferris's recordings at mean luma ~46 and
// saturation ~8 against 84-100 / 15-24 in play), and the death screen, where the camera follows a
// teammate and a "DEFEATED BY" card sits bottom right. Checked on small frames, cached per file.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { FEED_SAMPLE, feedSamples, slotStats, type FeedSample, type SlotStats } from './feed-rows';
import { feedCropFilter } from './render';
import {
  COUNTDOWN_BOX, DEATH_BOX, DEATH_MIN, DEATH_TEMPLATE, countdownCropFilter, countdownInRgb, deadSpans, deathCropFilter, deathScore, unpad, type DeadSample,
} from '../vision/death-screen';

export interface FrameStats {
  /** Mean luma 0..255. */
  y: number;
  /** Mean saturation 0..255 (max-min of RGB). */
  sat: number;
  /** Mean luma of the left fifth of the frame (outside the scoreboard panel). */
  leftY: number;
}

export function frameStats(rgb: Uint8Array, width: number, height: number): FrameStats {
  let y = 0;
  let sat = 0;
  let left = 0;
  let leftN = 0;
  const leftW = Math.max(1, Math.round(width * 0.19));
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const o = (j * width + i) * 3;
      const r = rgb[o];
      const g = rgb[o + 1];
      const b = rgb[o + 2];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      y += l;
      sat += Math.max(r, g, b) - Math.min(r, g, b);
      if (i < leftW) {
        left += l;
        leftN++;
      }
    }
  }
  const n = width * height;
  return { y: y / n, sat: sat / n, leftY: left / leftN };
}

// Measured on real scoreboard frames (48x20; the means hold at the 120x20 used now): mean luma 31-40, left strip 17-29, saturation (max-min)
// under 30; gameplay luma 84-100. Dark gameplay can be as dark but keeps its colour, so saturation
// tells them apart.
export const isScoreboard = (s: FrameStats) => s.y < 60 && s.leftY < 50 && s.sat < 30;

/** Keep only flagged samples that have a flagged neighbour (the scoreboard is held, not a single dark frame). */
export function heldRuns(flags: boolean[]): number[] {
  const times: number[] = [];
  flags.forEach((f, i) => {
    if (f && (flags[i - 1] || flags[i + 1])) times.push(i / 4);
  });
  return times;
}

const W = FEED_SAMPLE.width;
const H = 20;
const FH = FEED_SAMPLE.height;

// ---------- death screen ----------

// The card's template and scoring live with the live detector (vision/death-screen.ts).
export { DEATH_BOX, DEATH_MIN, DEATH_TEMPLATE, deathScore };
export { countdownCropFilter, deathCropFilter, unpad };

export interface ClipScan {
  /** Times (seconds) where the clip shows the scoreboard, sampled 4 times a second. */
  scoreboard: number[];
  /**
   * Times (seconds) where you're dead: the respawn countdown or the "DEFEATED BY" card is on screen.
   * The first TRADE_S after a death seen as it happened are left out, so a kill that lands as you die still counts.
   */
  dead?: number[];
  /** Times (seconds) you died on camera (the countdown appearing). */
  deaths?: number[];
  /** Your rows in the kill feed, sampled at the same times. */
  feed: FeedSample[];
}

const cache = new Map<string, ClipScan>();
const EMPTY: ClipScan = { scoreboard: [], feed: [], dead: [], deaths: [] };

/** A kill up to this long after your death on camera still counts (a projectile landing, a trade). */
export const TRADE_S = 1.5;

/** Dead times and deaths from samples taken 4 times a second. */
export function readDeaths(samples: DeadSample[]): { dead: number[]; deaths: number[] } {
  const fresh = deadSpans(samples, 0.25).filter((s) => s.fresh).map((s) => s.from);
  const dead = heldRuns(samples.map((s) => s.countdown || s.card)).filter((t) => !fresh.some((d) => t >= d && t < d + TRADE_S));
  return { dead, deaths: fresh };
}

/** One small decode per clip: the whole frame (scoreboard check), the kill-feed crop and the death card's box, stacked. */
export function scanClip(ffmpeg: string, file: string, signal?: AbortSignal): Promise<ClipScan> {
  let key = file;
  try {
    const st = fs.statSync(file);
    key = `${file}|${st.size}|${st.mtimeMs}`;
  } catch {
    return Promise.resolve(EMPTY);
  }
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const DW = DEATH_BOX.w;
  const DH = DEATH_BOX.h;
  const CW = COUNTDOWN_BOX.w;
  const CH = COUNTDOWN_BOX.h;
  const graph = `[0:v]fps=${FEED_SAMPLE.fps},split=4[a][b][c][d];[a]scale=${W}:${H}:flags=area,format=rgb24[full];[b]${feedCropFilter()},scale=${W}:${FH}:flags=area,format=rgb24[feed];[c]${deathCropFilter()},scale=${DW}:${DH}:flags=area,format=rgb24,pad=${W}:${DH}:0:0[death];[d]${countdownCropFilter()},scale=${CW}:${CH}:flags=area,format=rgb24,pad=${W}:${CH}:0:0[cd];[full][feed][death][cd]vstack=inputs=4[out]`;
  return new Promise((resolve) => {
    execFile(ffmpeg, ['-v', 'error', '-i', file, '-t', '120', '-filter_complex', graph, '-map', '[out]', '-an', '-f', 'rawvideo', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true, signal }, (error, out) => {
        if (error) return resolve(EMPTY);
        const full = W * H * 3;
        const feedBytes = W * FH * 3;
        const deathBytes = W * DEATH_BOX.h * 3;
        const size = full + feedBytes + deathBytes + W * COUNTDOWN_BOX.h * 3;
        const flags: boolean[] = [];
        const deadSamples: DeadSample[] = [];
        const slots: SlotStats[][] = [];
        for (let f = 0; (f + 1) * size <= out.length; f++) {
          const frame = out.subarray(f * size, (f + 1) * size);
          flags.push(isScoreboard(frameStats(frame.subarray(0, full), W, H)));
          slots.push(slotStats(frame.subarray(full, full + feedBytes), W, FH));
          // The card's box sits at the left of a padded strip W wide: take its rows out.
          const card = unpad(frame.subarray(full + feedBytes, full + feedBytes + deathBytes), W, DEATH_BOX.w, DEATH_BOX.h);
          // The respawn countdown (top left) shows from the moment you die; the card only during the replay.
          const countdown = unpad(frame.subarray(full + feedBytes + deathBytes), W, COUNTDOWN_BOX.w, COUNTDOWN_BOX.h);
          deadSamples.push({ t: f / 4, card: deathScore(card) >= DEATH_MIN, countdown: countdownInRgb(countdown) });
        }
        const scan = { scoreboard: heldRuns(flags), feed: feedSamples(slots), ...readDeaths(deadSamples) };
        if (cache.size > 2000) cache.clear();
        cache.set(key, scan);
        resolve(scan);
      });
  });
}

/** Times (seconds) where the clip shows the scoreboard, sampled 4 times a second. */
export async function scoreboardTimes(ffmpeg: string, file: string, signal?: AbortSignal): Promise<number[]> {
  return (await scanClip(ffmpeg, file, signal)).scoreboard;
}

/**
 * Trim a clip so it doesn't show the scoreboard: cut it off before the first kill or after the last.
 * Returns null when the scoreboard sits between kills (the clip can't be used as one piece).
 */
export function trimAround<T extends { in: number; out: number; hits: number[] }>(clip: T, bad: number[]): T | null {
  const inside = bad.filter((t) => t >= clip.in - 0.25 && t <= clip.out + 0.25);
  if (!inside.length) return clip;
  const hits = clip.hits.filter((h) => h > clip.in && h < clip.out);
  if (!hits.length) return null;
  const first = hits[0];
  const last = hits[hits.length - 1];
  let a = clip.in;
  let b = clip.out;
  for (const t of inside) {
    if (t < first - 0.6) a = Math.max(a, t + 0.3);
    // Samples are 0.25 s apart, so the scoreboard may open up to a sample before the first flagged one.
    else if (t > last + 0.3) b = Math.min(b, t - 0.3);
    else return null;
  }
  // Keep at least 1.5 s of build-up, or the clip opens straight on the kill.
  return first - a >= 1.5 && b > last ? { ...clip, in: a, out: b } : null;
}
