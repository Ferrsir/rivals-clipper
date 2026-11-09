// Finds your own rows in the game's kill feed. Rivals draws the kills you made on a white plate and
// everyone else's on a dark one, so a slot that is mostly bright and grey holds one of your kills.
// The feed box then shows only those rows (other players' rows read as broken smudges once the
// scenery behind them is darkened), and kill times are moved to the moment your row appears:
// the clipper's detection runs up to a second late, and can count a teammate's kill as yours.

import type { FeedRow, ReelClip } from '../../shared/studio';

export const FEED_SLOTS = 3;
export const FEED_SAMPLE = { width: 120, height: 30, fps: 4 };
/**
 * A slot holds your row when this share of it is white plate and the plate ends near the feed's right
 * edge. Measured on Ferris's footage (120x30 crop): own rows 0.1-0.23; the plate's right edge sits at
 * 108-119 of 120 (it stops short of the victim's portrait on some rows) and a short name like
 * "Ferrsir" starts the plate past the middle; other players' rows 0-0.002; bright scenery fakes rows
 * that end further left.
 */
export const OWN_ROW = { min: 0.09, max: 0.26, right: [0.85, 0.995] as const, maxLeft: 0.65 };

export interface SlotStats {
  /** Share of the slot's pixels that are white plate (bright, grey). */
  white: number;
  /** Left and right edge of the plate, 0..1 of the box width (1/0 when there is none). */
  x0: number;
  x1: number;
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
    out.push({ white: n / Math.max(1, (y1 - y0) * width), x0: x1 < 0 ? 1 : x0 / width, x1: x1 < 0 ? 0 : (x1 + 1) / width });
  }
  return out;
}

export interface FeedSample {
  t: number;
  /** Per slot: the plate's left edge (0..1) when it holds your row, else null. */
  own: Array<number | null>;
}

export function feedSamples(stats: SlotStats[][], fps = FEED_SAMPLE.fps): FeedSample[] {
  return stats.map((slots, f) => ({ t: f / fps, own: slots.map((s) => (isOwnRow(s) ? s.x0 : null)) }));
}

export function isOwnRow(s: SlotStats): boolean {
  return s.white >= OWN_ROW.min && s.white <= OWN_ROW.max && s.x1 >= OWN_ROW.right[0] && s.x1 <= OWN_ROW.right[1] && s.x0 <= OWN_ROW.maxLeft;
}

/** Time spans (clip seconds) when each slot shows your row, with the leftmost edge it reached. */
export function ownRows(samples: FeedSample[], fps = FEED_SAMPLE.fps): FeedRow[] {
  // A row shows from the first sample it is seen in until just after the last: between samples it may
  // already be sliding to the next slot, and the fixed slot would then show scenery.
  const step = 1 / fps;
  const rows: FeedRow[] = [];
  const slots = samples[0]?.own.length ?? 0;
  const edges = new Map<FeedRow, number[]>();
  const seen = new Map<FeedRow, number>();
  for (let s = 0; s < slots; s++) {
    let cur: FeedRow | null = null;
    let last = -Infinity;
    for (const smp of samples) {
      const x = smp.own[s];
      if (x != null) {
        if (cur && smp.t - last <= step + 1e-6) {
          cur.to = smp.t + 0.4 * step;
        } else {
          cur = { slot: s, from: smp.t, to: smp.t + 0.4 * step, x0: x };
          rows.push(cur);
          edges.set(cur, []);
          seen.set(cur, 0);
        }
        last = smp.t;
        edges.get(cur)!.push(x);
        seen.set(cur, seen.get(cur)! + 1);
      } else cur = null;
    }
  }
  // The plate's left edge is the median one, so scenery that joins the plate for a frame doesn't widen
  // the cut-out; a little margin keeps the first letter. A single sample is a flash, not a row.
  for (const r of rows) {
    const xs = edges.get(r)!.sort((a, b) => a - b);
    r.x0 = xs[Math.floor(xs.length / 2)];
  }
  return rows.filter((r) => seen.get(r)! >= 2).sort((a, b) => a.from - b.from || a.slot - b.slot);
}

/**
 * Moments a new row of yours enters the feed. New rows enter the top slot and older ones slide down,
 * so a kill shows as the top slot turning into your row, or as one more of your rows than before
 * (a quick second kill pushes the first one down while the top slot stays yours, and a teammate's
 * row can push yours down between two samples). Either must hold for the next sample too.
 */
export function rowOnsets(samples: FeedSample[], fps = FEED_SAMPLE.fps): number[] {
  const out: number[] = [];
  const count = (smp?: FeedSample) => (smp ? smp.own.filter((x) => x != null).length : 0);
  samples.forEach((smp, i) => {
    if (i === 0) return;
    const prev = samples[i - 1];
    const next = samples[i + 1];
    const topNew = smp.own[0] != null && prev.own[0] == null && next?.own[0] != null;
    const more = count(smp) > count(prev) && count(next) >= count(smp);
    if (topNew || more) out.push(Math.max(0, smp.t - 0.5 / fps));
  });
  return out;
}

/**
 * Your kills are the moments your rows appear in the feed. The clipper's own kill times run up to two
 * seconds late and often count a teammate's kill as yours, so once the feed can be read they are
 * replaced outright: a clip with no row of yours has no kills of yours.
 * Leaves the clip as it is when the feed couldn't be scanned.
 */
export function withFeedRows<T extends Pick<ReelClip, 'hits' | 'kills'> & { feedRows?: FeedRow[]; in?: number; out?: number }>(clip: T, samples: FeedSample[]): T {
  if (!samples.length) return clip;
  const rows = ownRows(samples);
  const a = clip.in ?? 0;
  const b = clip.out ?? Infinity;
  const hits = rowOnsets(samples).filter((t) => t >= a && t <= b);
  return { ...clip, hits, kills: hits.length, feedRows: rows };
}

/** Your own death also puts a white-plated row in the feed, and kills while the "DEFEATED BY" card is up are
 *  someone else's camera: drop any kill within 0.75 s of a dead sample. */
export function dropWhileDead(hits: number[], dead: number[] | undefined): number[] {
  if (!dead?.length) return hits;
  return hits.filter((h) => !dead.some((t) => Math.abs(t - h) <= 0.75));
}
