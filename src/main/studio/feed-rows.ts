// Finds your own rows in the game's kill feed. Rivals draws the kills you made on a white plate and
// everyone else's on a dark one, so a slot that is mostly bright and grey holds one of your kills.
// The feed box then shows only those rows (other players' rows read as broken smudges once the
// scenery behind them is darkened), and kill times are moved to the moment your row appears:
// the clipper's detection runs up to a second late, and can count a teammate's kill as yours.

import type { FeedRow, ReelClip } from '../../shared/studio';

export const FEED_SLOTS = 3;
export const FEED_SAMPLE = { width: 120, height: 30, fps: 4 };
/**
 * A slot holds your row when this share of it is white plate and the plate ends at the feed's right
 * edge. Measured on Ferris's footage (120x30 crop): own rows 0.13-0.23 with the right edge at
 * 117-118 of 120; other players' rows 0-0.002; bright scenery fakes rows that don't end there.
 */
export const OWN_ROW = { min: 0.1, max: 0.26, right: [0.955, 0.995] as const, maxLeft: 0.5 };

export interface SlotStats {
  /** Share of the slot's pixels that are white plate (bright, grey). */
  white: number;
  /** Left and right edge of the plate, 0..1 of the box width (1/0 when there is none). */
  x0: number;
  x1: number;
  /** Top and bottom of the plate, 0..1 of the box height (found around the slot, so a row that sits
   * across a slot boundary is kept whole). */
  y0: number;
  y1: number;
}

/** Where one of your rows' plates sits in the box, all 0..1. */
export interface RowEdge {
  x0: number;
  y0: number;
  y1: number;
}

const isPlate = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b > 190 && Math.max(r, g, b) - Math.min(r, g, b) < 45;

/** Stats for each row slot of one feed-crop frame (rgb24, width x height). */
export function slotStats(rgb: Uint8Array, width: number, height: number, slots = FEED_SLOTS): SlotStats[] {
  const out: SlotStats[] = [];
  const cols = new Uint16Array(width);
  for (let s = 0; s < slots; s++) {
    const y0 = Math.round((s * height) / slots);
    const y1 = Math.round(((s + 1) * height) / slots);
    cols.fill(0);
    let n = 0;
    for (let j = y0; j < y1; j++) {
      for (let i = 0; i < width; i++) {
        const o = (j * width + i) * 3;
        if (isPlate(rgb[o], rgb[o + 1], rgb[o + 2])) {
          cols[i]++;
          n++;
        }
      }
    }
    // Plate edges: columns where at least a third of the slot height is plate (ignores stray text pixels).
    const need = Math.max(1, Math.round((y1 - y0) / 3));
    let x0 = width;
    let x1 = -1;
    for (let i = 0; i < width; i++) if (cols[i] >= need) { x0 = Math.min(x0, i); x1 = i; }
    // Plate rows: lines where most of the plate's width is plate. Take the run through the fullest
    // line of the slot, letting it grow a few lines past the slot so the row is never cut.
    let top = y0;
    let bottom = y1;
    if (x1 >= 0) {
      const lineFill = (j: number) => {
        let k = 0;
        for (let i = x0; i <= x1; i++) {
          const o = (j * width + i) * 3;
          if (isPlate(rgb[o], rgb[o + 1], rgb[o + 2])) k++;
        }
        return k / (x1 - x0 + 1);
      };
      let best = y0;
      for (let j = y0; j < y1; j++) if (lineFill(j) > lineFill(best)) best = j;
      const reach = Math.max(1, Math.round((y1 - y0) / 3));
      top = best;
      bottom = best + 1;
      while (top - 1 >= Math.max(0, y0 - reach) && lineFill(top - 1) >= 0.4) top--;
      while (bottom < Math.min(height, y1 + reach) && lineFill(bottom) >= 0.4) bottom++;
    }
    out.push({ white: n / Math.max(1, (y1 - y0) * width), x0: x1 < 0 ? 1 : x0 / width, x1: x1 < 0 ? 0 : (x1 + 1) / width, y0: top / height, y1: bottom / height });
  }
  return out;
}

export interface FeedSample {
  t: number;
  /** Per slot: where the plate is when it holds your row, else null. */
  own: Array<RowEdge | null>;
}

export function feedSamples(stats: SlotStats[][], fps = FEED_SAMPLE.fps): FeedSample[] {
  return stats.map((slots, f) => ({ t: f / fps, own: slots.map((s) => (isOwnRow(s) ? { x0: s.x0, y0: s.y0, y1: s.y1 } : null)) }));
}

export function isOwnRow(s: SlotStats): boolean {
  return s.white >= OWN_ROW.min && s.white <= OWN_ROW.max && s.x1 >= OWN_ROW.right[0] && s.x1 <= OWN_ROW.right[1] && s.x0 <= OWN_ROW.maxLeft;
}

/** Time spans (clip seconds) when each slot shows your row, with the leftmost edge it reached. */
export function ownRows(samples: FeedSample[], fps = FEED_SAMPLE.fps): FeedRow[] {
  const half = 0.5 / fps;
  const rows: FeedRow[] = [];
  const slots = samples[0]?.own.length ?? 0;
  const edges = new Map<FeedRow, RowEdge[]>();
  for (let s = 0; s < slots; s++) {
    let cur: FeedRow | null = null;
    for (const smp of samples) {
      const e = smp.own[s];
      if (e != null) {
        if (cur && smp.t - half <= cur.to + 1e-6) {
          cur.to = smp.t + half;
        } else {
          cur = { slot: s, from: Math.max(0, smp.t - half), to: smp.t + half, x0: e.x0 };
          rows.push(cur);
          edges.set(cur, []);
        }
        edges.get(cur)!.push(e);
      } else cur = null;
    }
  }
  // The plate's edges are the median ones, so scenery that joins the plate for a frame doesn't widen
  // the cut-out. A single sample is a flash, not a row.
  const median = (v: number[]) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)];
  for (const r of rows) {
    const es = edges.get(r)!;
    r.x0 = median(es.map((e) => e.x0));
    r.y0 = median(es.map((e) => e.y0));
    r.y1 = median(es.map((e) => e.y1));
  }
  return rows.filter((r) => r.to - r.from > 1.5 / fps).sort((a, b) => a.from - b.from || a.slot - b.slot);
}

/**
 * Moments a new row of yours enters the feed. New rows always enter the top slot (older ones slide
 * down), so a kill is the top slot turning into your row and holding for two samples.
 */
export function rowOnsets(samples: FeedSample[], fps = FEED_SAMPLE.fps): number[] {
  const out: number[] = [];
  samples.forEach((smp, i) => {
    const top = smp.own[0] != null;
    const before = i > 0 && samples[i - 1].own[0] != null;
    const held = samples[i + 1]?.own[0] != null;
    if (top && !before && held) out.push(Math.max(0, smp.t - 0.5 / fps));
  });
  return out;
}

/**
 * Put each kill on the moment its row appears, and drop kills with no row of yours (a teammate's).
 * Leaves the clip as it is when the feed couldn't be scanned.
 */
export function withFeedRows<T extends Pick<ReelClip, 'hits' | 'kills'> & { feedRows?: FeedRow[] }>(clip: T, samples: FeedSample[]): T {
  // No samples means the scan failed: keep the clip as the clipper logged it. A readable feed with no
  // rows of yours means none of these kills are yours (every row is a teammate's or an enemy's).
  if (!samples.length) return clip;
  const rows = ownRows(samples);
  const onsets = rowOnsets(samples);
  const used = new Set<number>();
  const hits: number[] = [];
  for (const h of clip.hits) {
    // The row shows up to ~1.2 s before the clipper logs the kill, and never much after it.
    const i = onsets.findIndex((o, k) => !used.has(k) && o >= h - 1.5 && o <= h + 0.5);
    if (i < 0) continue;
    used.add(i);
    hits.push(onsets[i]);
  }
  return { ...clip, hits, kills: hits.length, feedRows: rows };
}
