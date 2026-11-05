// Keeps a picture glued to a face. The signed-in AI finds the face on a few frames (it knows who
// "Gojo" is, even drawn); between those, this follows it on every frame by matching the patch of
// pixels around the face (normalised cross-correlation on small greyscale frames). Where the match is
// lost, it falls back to the AI's positions. Runs locally, no extra downloads.

import { execFile } from 'node:child_process';
import type { OverlayKey } from '../../shared/studio';

export interface GreyFrames {
  w: number;
  h: number;
  fps: number;
  /** Source second of frame 0. */
  start: number;
  frames: Uint8Array[];
}

/** A face the AI saw: centre and width as fractions of the frame. */
export interface FaceAnchor {
  t: number;
  x: number;
  y: number;
  size: number;
}

/** Greyscale frames of part of a video, `w` pixels wide. */
export function greyFrames(ffmpeg: string, file: string, from: number, to: number, o: { w?: number; fps?: number; srcW: number; srcH: number; signal?: AbortSignal }): Promise<GreyFrames> {
  const w = o.w ?? 320;
  const fps = o.fps ?? 15;
  const h = Math.max(2, Math.round((w * (o.srcH || 1080)) / (o.srcW || 1920) / 2) * 2);
  const span = Math.max(0.1, to - from);
  return new Promise((resolve, reject) => {
    execFile(
      ffmpeg,
      ['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', from.toFixed(3), '-t', span.toFixed(3), '-i', file, '-an', '-vf', `fps=${fps},scale=${w}:${h}:flags=area,format=gray`, '-f', 'rawvideo', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024, windowsHide: true, timeout: 180_000, signal: o.signal },
      (err, stdout) => {
        if (err) return reject(err);
        const buf = stdout as Buffer;
        const n = Math.floor(buf.length / (w * h));
        const frames: Uint8Array[] = [];
        for (let i = 0; i < n; i++) frames.push(new Uint8Array(buf.buffer.slice(buf.byteOffset + i * w * h, buf.byteOffset + (i + 1) * w * h)));
        resolve({ w, h, fps, start: from, frames });
      },
    );
  });
}

interface Patch {
  r: number;
  data: Float64Array;
}

function cutPatch(f: Uint8Array, w: number, h: number, cx: number, cy: number, r: number): Patch | null {
  if (cx - r < 0 || cy - r < 0 || cx + r >= w || cy + r >= h) return null;
  const side = 2 * r + 1;
  const data = new Float64Array(side * side);
  let mean = 0;
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) mean += data[y * side + x] = f[(cy - r + y) * w + (cx - r + x)];
  mean /= data.length;
  let sd = 0;
  for (let i = 0; i < data.length; i++) {
    data[i] -= mean;
    sd += data[i] * data[i];
  }
  sd = Math.sqrt(sd) || 1;
  for (let i = 0; i < data.length; i++) data[i] /= sd;
  return { r, data };
}

/** Normalised cross-correlation of the patch centred at (cx, cy); -1..1. */
function ncc(f: Uint8Array, w: number, h: number, p: Patch, cx: number, cy: number, step = 1): number {
  const r = p.r;
  if (cx - r < 0 || cy - r < 0 || cx + r >= w || cy + r >= h) return -1;
  const side = 2 * r + 1;
  let sum = 0;
  let sq = 0;
  let dot = 0;
  let n = 0;
  for (let y = 0; y < side; y += step) {
    const row = (cy - r + y) * w + (cx - r);
    for (let x = 0; x < side; x += step) {
      const v = f[row + x];
      sum += v;
      sq += v * v;
      dot += v * p.data[y * side + x];
      n++;
    }
  }
  const varr = sq - (sum * sum) / n;
  if (varr <= 1e-6) return -1;
  // The patch is zero-mean, so the mean of the window drops out of the dot product.
  return (dot / Math.sqrt(varr)) * (step === 1 ? 1 : Math.sqrt((side * side) / n));
}

function search(f: Uint8Array, w: number, h: number, p: Patch, px: number, py: number, radius: number): { x: number; y: number; score: number } {
  let best = { x: px, y: py, score: -2 };
  for (let dy = -radius; dy <= radius; dy += 2)
    for (let dx = -radius; dx <= radius; dx += 2) {
      const s = ncc(f, w, h, p, px + dx, py + dy, 2);
      if (s > best.score) best = { x: px + dx, y: py + dy, score: s };
    }
  const coarse = best;
  best = { ...coarse, score: -2 };
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const s = ncc(f, w, h, p, coarse.x + dx, coarse.y + dy);
      if (s > best.score) best = { x: coarse.x + dx, y: coarse.y + dy, score: s };
    }
  return best;
}

function lerpAnchors(a: FaceAnchor[], t: number): FaceAnchor {
  if (t <= a[0].t) return { ...a[0], t };
  for (let i = 0; i < a.length - 1; i++) {
    if (t <= a[i + 1].t) {
      const k = (t - a[i].t) / Math.max(1e-6, a[i + 1].t - a[i].t);
      return { t, x: a[i].x + (a[i + 1].x - a[i].x) * k, y: a[i].y + (a[i + 1].y - a[i].y) * k, size: a[i].size + (a[i + 1].size - a[i].size) * k };
    }
  }
  return { ...a[a.length - 1], t };
}

/**
 * Follow the face through every frame, starting from the AI's sightings. Returns one key per frame
 * (fractions of the frame, times in source seconds).
 */
export function trackFace(g: GreyFrames, anchors: FaceAnchor[], o: { minScore?: number } = {}): OverlayKey[] {
  const minScore = o.minScore ?? 0.55;
  const list = [...anchors].sort((a, b) => a.t - b.t);
  if (!list.length || !g.frames.length) return [];
  const { w, h } = g;
  const keys: OverlayKey[] = [];
  let patch: Patch | null = null;
  let px = 0;
  let py = 0;
  let next = 0;
  for (let i = 0; i < g.frames.length; i++) {
    const f = g.frames[i];
    const t = g.start + i / g.fps;
    const ai = lerpAnchors(list, t);
    const r = Math.max(4, Math.min(40, Math.round((ai.size * w) / 2 * 0.8)));
    // Re-anchor on each AI sighting: it knows who the character is; the tracker only knows pixels.
    let reanchor = !patch;
    while (next < list.length && list[next].t <= t + 0.5 / g.fps) {
      const a = list[next++];
      const dist = Math.hypot(a.x * w - px, a.y * h - py);
      if (!patch || dist > a.size * w * 0.5) reanchor = true;
    }
    let x: number;
    let y: number;
    if (reanchor) {
      x = Math.round(ai.x * w);
      y = Math.round(ai.y * h);
      patch = cutPatch(f, w, h, x, y, r);
    } else {
      const found = search(f, w, h, patch!, px, py, Math.max(6, Math.round(r * 1.2)));
      if (found.score >= minScore) {
        x = found.x;
        y = found.y;
        // Let the patch adapt slowly to turning heads and lighting.
        const fresh = cutPatch(f, w, h, x, y, patch!.r);
        if (fresh) for (let k = 0; k < fresh.data.length; k++) patch!.data[k] = patch!.data[k] * 0.85 + fresh.data[k] * 0.15;
      } else {
        // Lost (a cut, a blur, an effect): trust the AI's path until it is found again.
        x = Math.round(ai.x * w);
        y = Math.round(ai.y * h);
        patch = cutPatch(f, w, h, x, y, r) ?? patch;
      }
    }
    px = x;
    py = y;
    keys.push({ t: Math.round(t * 1000) / 1000, x: x / w, y: y / h, size: ai.size });
  }
  return smoothKeys(keys, 2);
}

/** Moving average over ±n keys, to take out pixel jitter. */
export function smoothKeys(keys: OverlayKey[], n: number): OverlayKey[] {
  return keys.map((k, i) => {
    // Symmetric window, shrinking at the ends, so the path doesn't lag at the start or end.
    const m = Math.min(n, i, keys.length - 1 - i);
    const win = keys.slice(i - m, i + m + 1);
    return { ...k, x: win.reduce((s, q) => s + q.x, 0) / win.length, y: win.reduce((s, q) => s + q.y, 0) / win.length };
  });
}

/** Fewest keys that keep the path within `tol` of the full track (so the ffmpeg expression stays small). */
export function simplifyKeys(keys: OverlayKey[], tol = 0.004, max = 150): OverlayKey[] {
  if (keys.length <= 2) return keys;
  const keep = new Uint8Array(keys.length);
  keep[0] = keep[keys.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, keys.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const k = (keys[i].t - keys[a].t) / Math.max(1e-6, keys[b].t - keys[a].t);
      const ex = keys[a].x + (keys[b].x - keys[a].x) * k;
      const ey = keys[a].y + (keys[b].y - keys[a].y) * k;
      const es = keys[a].size + (keys[b].size - keys[a].size) * k;
      const d = Math.max(Math.hypot(keys[i].x - ex, keys[i].y - ey), Math.abs(keys[i].size - es) / 2);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tol && at > 0) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  let out = keys.filter((_, i) => keep[i]);
  if (out.length > max) out = simplifyKeys(keys, tol * 1.6, max);
  return out;
}
