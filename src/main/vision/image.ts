// Small, fast image helpers for the screen detector. Frames are BGRA (what ffmpeg's rawvideo gives),
// and every helper works on one region of the stacked HUD mosaic. No dependencies, so it could move to a worker thread.

import type { HudLayout, RegionGeom, RegionId } from './layout';

export const LIGHT = 1; // light grey / white background (your rows in the kill feed)
export const DARK = 2; // dark pixels (text on a light row)
export const WHITE = 4; // near-white (HUD text drawn over the game: KO list, banners)
export const BLUE = 8; // your team's blue
export const RED = 16; // the enemy team's red/orange
export const PALE = 32; // bright, unsaturated: HUD text that has started to fade (older KO-list lines)

export interface View {
  id: RegionId;
  w: number;
  h: number;
  /** Mosaic pixels per HUD unit. */
  u: number;
  /** One byte per pixel with the class bits above. */
  mask: Uint8Array;
  /** Luma (0-255) per pixel. */
  luma: Uint8Array;
}

/** Classifies every pixel of one region once, so detectors only count bits. */
export function makeView(frame: Uint8Array, layout: HudLayout, g: RegionGeom): View {
  const w = g.outW;
  const h = g.outH;
  const stride = layout.mosaicW * 4;
  const mask = new Uint8Array(w * h);
  const luma = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let p = (g.outY + y) * stride;
    const row = y * w;
    for (let x = 0; x < w; x++, p += 4) {
      const b = frame[p];
      const gr = frame[p + 1];
      const r = frame[p + 2];
      const max = r > gr ? (r > b ? r : b) : gr > b ? gr : b;
      const min = r < gr ? (r < b ? r : b) : gr < b ? gr : b;
      const l = (r * 77 + gr * 150 + b * 29) >> 8;
      const sat = max - min;
      let m = 0;
      if (max >= 165 && sat <= 60) m |= LIGHT;
      if (l < 105) m |= DARK;
      if (l >= 200 && sat <= 70) m |= WHITE;
      if (l >= 150 && sat <= 60) m |= PALE;
      if (b >= 160 && b - r >= 60 && b >= gr) m |= BLUE;
      if (r >= 170 && r - b >= 70 && r - gr >= 30) m |= RED;
      mask[row + x] = m;
      luma[row + x] = g.id === 'subtitle' && b > 120 && gr > 70 && b - r > 35 ? 255 : l;
    }
  }
  return { id: g.id, w, h, u: g.pxPerUnit, mask, luma };
}

export function viewFor(frame: Uint8Array, layout: HudLayout, id: RegionId): View {
  const g = layout.regions.find((r) => r.id === id);
  if (!g) throw new Error(`no region ${id}`);
  return makeView(frame, layout, g);
}

/** Pixels with `bit` set in each row, between columns x0 and x1. */
export function rowCounts(v: View, bit: number, x0 = 0, x1 = v.w): Uint16Array {
  const out = new Uint16Array(v.h);
  for (let y = 0; y < v.h; y++) {
    let n = 0;
    const row = y * v.w;
    for (let x = x0; x < x1; x++) if (v.mask[row + x] & bit) n++;
    out[y] = n;
  }
  return out;
}

export interface Band {
  y0: number;
  y1: number; // exclusive
}

/** Runs of rows whose count is at least `min`, allowing `maxGap` weak rows inside a run. */
export function findBands(counts: ArrayLike<number>, min: number, minLen: number, maxLen: number, maxGap = 1): Band[] {
  const out: Band[] = [];
  let start = -1;
  let gap = 0;
  let lastGood = -1;
  for (let y = 0; y <= counts.length; y++) {
    const good = y < counts.length && counts[y] >= min;
    if (good) {
      if (start < 0) start = y;
      lastGood = y;
      gap = 0;
    } else if (start >= 0) {
      gap++;
      if (gap > maxGap || y === counts.length) {
        const len = lastGood + 1 - start;
        if (len >= minLen && len <= maxLen) out.push({ y0: start, y1: lastGood + 1 });
        start = -1;
        gap = 0;
      }
    }
  }
  return out;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number; // exclusive
  y1: number; // exclusive
}

/**
 * Columns inside a band where at least `minFrac` of the rows have `bit`.
 * Returns the widest run, joining runs separated by at most `maxGap` columns.
 */
export function columnExtent(v: View, band: Band, bit: number, minFrac: number, maxGap: number): { x0: number; x1: number } | undefined {
  const rows = band.y1 - band.y0;
  const need = Math.max(1, Math.ceil(rows * minFrac));
  let best: { x0: number; x1: number } | undefined;
  let start = -1;
  let last = -1;
  for (let x = 0; x <= v.w; x++) {
    let n = 0;
    if (x < v.w) for (let y = band.y0; y < band.y1; y++) if (v.mask[y * v.w + x] & bit) n++;
    const good = x < v.w && n >= need;
    if (good) {
      if (start < 0) start = x;
      last = x;
    } else if (start >= 0 && (x - last > maxGap || x === v.w)) {
      if (!best || last + 1 - start > best.x1 - best.x0) best = { x0: start, x1: last + 1 };
      start = -1;
    }
  }
  return best;
}

/** Fraction of pixels in a box that have `bit`. */
export function fraction(v: View, b: Box, bit: number): number {
  let n = 0;
  let total = 0;
  for (let y = b.y0; y < b.y1; y++) {
    const row = y * v.w;
    for (let x = b.x0; x < b.x1; x++) {
      total++;
      if (v.mask[row + x] & bit) n++;
    }
  }
  return total ? n / total : 0;
}

/** Average number of on/off changes of `bit` per row, per 100 HUD units of width (text has many). */
export function transitionDensity(v: View, b: Box, bit: number): number {
  let changes = 0;
  const rows = b.y1 - b.y0;
  for (let y = b.y0; y < b.y1; y++) {
    const row = y * v.w;
    let prev = (v.mask[row + b.x0] & bit) !== 0;
    for (let x = b.x0 + 1; x < b.x1; x++) {
      const cur = (v.mask[row + x] & bit) !== 0;
      if (cur !== prev) changes++;
      prev = cur;
    }
  }
  const widthUnits = (b.x1 - b.x0) / v.u;
  return rows && widthUnits ? (changes / rows / widthUnits) * 100 : 0;
}

/**
 * A small fingerprint of a box: mean luma on a grid, normalised so brightness changes don't matter.
 * Two looks at the same kill-feed row give close fingerprints even if the row moved.
 */
export function signature(v: View, b: Box, cols = 24, rows = 4): Float32Array {
  const sig = new Float32Array(cols * rows);
  const bw = b.x1 - b.x0;
  const bh = b.y1 - b.y0;
  for (let gy = 0; gy < rows; gy++) {
    const ya = b.y0 + Math.floor((gy * bh) / rows);
    const yb = Math.max(ya + 1, b.y0 + Math.floor(((gy + 1) * bh) / rows));
    for (let gx = 0; gx < cols; gx++) {
      const xa = b.x0 + Math.floor((gx * bw) / cols);
      const xb = Math.max(xa + 1, b.x0 + Math.floor(((gx + 1) * bw) / cols));
      let s = 0;
      let n = 0;
      for (let y = ya; y < yb && y < v.h; y++) for (let x = xa; x < xb && x < v.w; x++, n++) s += v.luma[y * v.w + x];
      sig[gy * cols + gx] = n ? s / n : 0;
    }
  }
  let mean = 0;
  for (const s of sig) mean += s;
  mean /= sig.length;
  let varSum = 0;
  for (const s of sig) varSum += (s - mean) ** 2;
  const sd = Math.sqrt(varSum / sig.length) || 1;
  for (let i = 0; i < sig.length; i++) sig[i] = (sig[i] - mean) / sd;
  return sig;
}

/** Mean absolute difference between two fingerprints (0 = identical, ~1.1 = unrelated). */
export function sigDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}

export interface Crop {
  w: number;
  h: number;
  /** Luma, row-major. */
  data: Uint8Array;
}

/** Copies the luma of a box (with a margin) for OCR. */
export function cropLuma(v: View, b: Box, marginUnits = 4): Crop {
  const m = Math.round(marginUnits * v.u);
  const x0 = Math.max(0, b.x0 - m);
  const y0 = Math.max(0, b.y0 - m);
  const x1 = Math.min(v.w, b.x1 + m);
  const y1 = Math.min(v.h, b.y1 + m);
  const w = x1 - x0;
  const h = y1 - y0;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) data.set(v.luma.subarray((y0 + y) * v.w + x0, (y0 + y) * v.w + x1), y * w);
  return { w, h, data };
}

export function cropAll(v: View): Crop {
  return { w: v.w, h: v.h, data: v.luma.slice() };
}

/**
 * Fingerprint from the text's shape: how many `bit` pixels each column has, resampled to `bins`.
 * Finer than `signature` along the line, so two short names in the same place still differ.
 */
export function columnProfile(v: View, b: Box, bit: number, bins = 64): Float32Array {
  const w = b.x1 - b.x0;
  const raw = new Float32Array(w);
  for (let x = b.x0; x < b.x1; x++) {
    let n = 0;
    for (let y = b.y0; y < b.y1; y++) if (v.mask[y * v.w + x] & bit) n++;
    raw[x - b.x0] = n;
  }
  const out = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    const a = Math.floor((i * w) / bins);
    const z = Math.max(a + 1, Math.floor(((i + 1) * w) / bins));
    let s = 0;
    for (let x = a; x < z && x < w; x++) s += raw[x];
    out[i] = s / (z - a);
  }
  let mean = 0;
  for (const s of out) mean += s;
  mean /= bins;
  let varSum = 0;
  for (const s of out) varSum += (s - mean) ** 2;
  const sd = Math.sqrt(varSum / bins) || 1;
  for (let i = 0; i < bins; i++) out[i] = (out[i] - mean) / sd;
  return out;
}

/** Distance between two column profiles, allowing a shift of up to `maxShift` bins. */
export function profileDistance(a: Float32Array, b: Float32Array, maxShift = 2): number {
  if (a.length !== b.length) return Infinity;
  let best = Infinity;
  for (let s = -maxShift; s <= maxShift; s++) {
    let d = 0;
    let n = 0;
    for (let i = 0; i < a.length; i++) {
      const j = i + s;
      if (j < 0 || j >= b.length) continue;
      d += Math.abs(a[i] - b[j]);
      n++;
    }
    if (n && d / n < best) best = d / n;
  }
  return best;
}
