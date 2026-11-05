// Rejects clips whose footage isn't gameplay, so the Studio never picks them on its own: the Tab
// scoreboard (whole screen darkened and grey, measured on Ferris's recordings at mean luma ~46 and
// saturation ~8 against 84-100 / 15-24 in play). Checked on small frames, cached per file.

import { execFile } from 'node:child_process';
import fs from 'node:fs';

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

// Measured on real scoreboard frames (48x20): mean luma 31-40, left strip 17-29, saturation (max-min)
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

const W = 48;
const H = 20;
const cache = new Map<string, number[]>();

/** Times (seconds) where the clip shows the scoreboard, sampled 4 times a second. */
export function scoreboardTimes(ffmpeg: string, file: string, signal?: AbortSignal): Promise<number[]> {
  let key = file;
  try {
    const st = fs.statSync(file);
    key = `${file}|${st.size}|${st.mtimeMs}`;
  } catch {
    return Promise.resolve([]);
  }
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    execFile(ffmpeg, ['-v', 'error', '-i', file, '-t', '120', '-vf', `fps=4,scale=${W}:${H}:flags=area,format=rgb24`, '-an', '-f', 'rawvideo', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true, signal }, (error, out) => {
        if (error) return resolve([]);
        const size = W * H * 3;
        const flags: boolean[] = [];
        for (let f = 0; (f + 1) * size <= out.length; f++) flags.push(isScoreboard(frameStats(out.subarray(f * size, (f + 1) * size), W, H)));
        const times = heldRuns(flags);
        if (cache.size > 2000) cache.clear();
        cache.set(key, times);
        resolve(times);
      });
  });
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
