// The screen detectors. Each looks at one HUD region of the stacked mosaic and reports things that
// newly appeared: one of your rows in the kill feed, a name in your KO list, a KO-streak banner, and
// whether the in-match HUD is showing. Deciding what those mean (a kill, a death, a match) happens in
// fusion.ts. Thresholds are in HUD units (see layout.ts) so they hold at any resolution.

import {
  BLUE, DARK, LIGHT, PALE, RED, WHITE, columnExtent, cropAll, cropLuma, findBands, fraction, rowCounts, signature, sigDistance,
  transitionDensity, viewFor, type Box, type Crop, type View,
} from './image';
import type { HudLayout, RegionId } from './layout';

export type Observation =
  | { kind: 'feed-row'; t: number; id: number; box: Box; crop: Crop }
  | { kind: 'ko-line'; t: number; id: number; box: Box; crop: Crop }
  | { kind: 'banner'; t: number; id: number; box: Box; crop: Crop }
  | { kind: 'hud'; t: number; matchHud: boolean; feedRows: number; koLines: number }
  | { kind: 'crop'; t: number; region: RegionId; crop: Crop };

export interface Candidate {
  box: Box;
  sig: Float32Array;
  /** False for a line that is shown but faded (an older entry). Weak lines are followed but never reported. */
  strong?: boolean;
}

interface Track {
  id: number;
  sig: Float32Array;
  box: Box;
  firstSeen: number;
  lastSeen: number;
  seen: number;
  /** Consecutive sightings without moving (a HUD line that has finished sliding in). */
  still: number;
  confirmed: boolean;
  /** Seen bright at least once. Lines that are only ever seen faded were on screen before we looked. */
  strong: boolean;
  reported: boolean;
}

export interface TrackerOptions {
  /** Still sightings needed before something counts as real. */
  confirmFrames: number;
  /** Max fingerprint distance to call two sightings the same thing. */
  matchDist: number;
  /** Movement (HUD units) that still counts as "not moving". */
  stillMove: number;
  /** How far a line may slide sideways while it animates in, per frame. */
  slideX: number;
  /** How far a shown line may move up or down when the list shifts, per frame. */
  shiftY: number;
  /** How long a confirmed line is remembered after it was last seen, so a flicker doesn't count twice. */
  memoryMs: number;
  /** How long an unconfirmed sighting waits for its next frame. */
  pendingMs: number;
}

let nextId = 1;
/** A line that only turns bright this long after it appeared is an old one, not a new event. */
const REPORT_WINDOW_MS = 2000;

/**
 * Follows lines across frames and reports each one once, when it has been seen enough times
 * without moving. Lines may slide in sideways (the game animates them) and shift up or down when
 * the list scrolls; things that drift diagonally (damage numbers, the game world) never settle.
 */
export class LineTracker {
  private tracks: Track[] = [];
  constructor(private o: TrackerOptions) {}

  update(cands: Candidate[], t: number, u: number, frameMs: number): Track[] {
    const fresh: Track[] = [];
    // Best matches first, so a new line can't steal the track of the line it replaced.
    const pairs: Array<{ tr: Track; c: Candidate; d: number }> = [];
    for (const c of cands) {
      for (const tr of this.tracks) {
        const d = sigDistance(tr.sig, c.sig);
        if (d >= this.o.matchDist || !similarWidth(tr.box, c.box)) continue;
        const dx = Math.abs(tr.box.x0 - c.box.x0) / u;
        const dy = Math.abs(tr.box.y0 - c.box.y0) / u;
        const ok = tr.confirmed ? dx <= this.o.stillMove * 2 && dy <= this.o.shiftY : dy <= this.o.stillMove && dx <= this.o.slideX;
        if (ok) pairs.push({ tr, c, d: d + (tr.confirmed ? 0 : 0.05) });
      }
    }
    pairs.sort((a, b) => a.d - b.d);
    const usedT = new Set<Track>();
    const usedC = new Set<Candidate>();
    for (const { tr, c } of pairs) {
      if (usedT.has(tr) || usedC.has(c)) continue;
      usedT.add(tr);
      usedC.add(c);
      const still = moved(tr.box, c.box) <= this.o.stillMove * u;
      tr.still = still ? tr.still + 1 : 1;
      tr.lastSeen = t;
      tr.seen++;
      tr.box = c.box;
      tr.sig = c.sig;
      if (c.strong !== false) tr.strong = true;
      if (!tr.confirmed && tr.still >= this.o.confirmFrames) tr.confirmed = true;
      // Report once it has settled and been bright; a line that fades in may settle first.
      if (tr.confirmed && tr.strong && !tr.reported && t - tr.firstSeen <= REPORT_WINDOW_MS) {
        tr.reported = true;
        fresh.push(tr);
      }
    }
    for (const c of cands) {
      if (usedC.has(c)) continue;
      const strong = c.strong !== false;
      const tr: Track = { id: nextId++, sig: c.sig, box: c.box, firstSeen: t, lastSeen: t, seen: 1, still: 1, confirmed: false, strong, reported: false };
      this.tracks.push(tr);
      if (this.o.confirmFrames <= 1) {
        tr.confirmed = true;
        if (strong) {
          tr.reported = true;
          fresh.push(tr);
        }
      }
    }
    const pendingLimit = Math.max(this.o.pendingMs, frameMs * 2.5);
    this.tracks = this.tracks.filter((tr) => (tr.confirmed ? t - tr.lastSeen <= this.o.memoryMs : t - tr.lastSeen <= pendingLimit));
    return fresh;
  }

  /** Lines currently on screen. */
  onScreen(t: number, frameMs: number): number {
    return this.tracks.filter((tr) => tr.confirmed && t - tr.lastSeen <= frameMs * 1.5).length;
  }

  reset(): void {
    this.tracks = [];
  }
}

function similarWidth(a: Box, b: Box): boolean {
  const wa = a.x1 - a.x0;
  const wb = b.x1 - b.x0;
  return Math.abs(wa - wb) <= Math.max(wa, wb) * 0.2 + 2;
}

function moved(a: Box, b: Box): number {
  return Math.max(Math.abs(a.x0 - b.x0), Math.abs(a.y0 - b.y0), Math.abs(a.x1 - b.x1));
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ---------- kill feed: your rows ----------

/** Finds kill-feed rows with the light background the game uses for rows that involve you. */
export function feedCandidates(v: View): Candidate[] {
  const u = v.u;
  const light = rowCounts(v, LIGHT);
  const out: Candidate[] = [];
  for (const band of findBands(light, 110 * u, 14 * u, 80 * u, Math.max(1, Math.round(2 * u)))) {
    const ext = columnExtent(v, band, LIGHT, 0.5, 30 * u);
    if (!ext || ext.x1 - ext.x0 < 180 * u) continue;
    const box = { x0: ext.x0, x1: ext.x1, y0: band.y0, y1: band.y1 };
    const lightFrac = fraction(v, box, LIGHT);
    const darkFrac = fraction(v, box, DARK);
    // A row is a light box with dark names in it: not a white wall, not a dark row.
    if (lightFrac < 0.45 || darkFrac < 0.03 || darkFrac > 0.5) continue;
    // Sharp top and bottom edges, unlike a bright sky behind the feed.
    const bandMedian = median(Array.from(light.subarray(band.y0, band.y1)));
    const off = Math.max(2, Math.round(4 * u));
    const above = band.y0 - off >= 0 ? light[band.y0 - off] : 0;
    const below = band.y1 - 1 + off < v.h ? light[band.y1 - 1 + off] : 0;
    if (above > bandMedian * 0.6 || below > bandMedian * 0.6) continue;
    out.push({ box, sig: signature(v, box, 32, 4) });
  }
  return out;
}

// ---------- KO list next to the crosshair ----------

export interface KoOptions {
  /** Where the KO list's icons line up, in HUD units from the region's left edge. Learned when known. */
  columnX?: number;
}

/**
 * Text lines starting near the KO column. The newest KO is drawn bright white and older ones fade
 * as the list scrolls up. Bright lines are the candidates; faded lines found on the paler mask are
 * added as weak ones, so an old line keeps its track while it moves and isn't mistaken for the new
 * line that took its place.
 */
export function koCandidates(v: View, opts: KoOptions = {}): Candidate[] {
  const strong = koLines(v, WHITE, opts);
  for (const c of strong) c.strong = true;
  const weak = koLines(v, PALE, opts).filter((c) => !strong.some((s) => overlapY(s.box, c.box)));
  for (const c of weak) c.strong = false;
  return [...strong, ...weak];
}

function overlapY(a: Box, b: Box): boolean {
  return Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0;
}

function koLines(v: View, bit: number, opts: KoOptions): Candidate[] {
  const u = v.u;
  const counts = rowCounts(v, bit);
  const out: Candidate[] = [];
  for (const band of findBands(counts, 6 * u, 10 * u, 48 * u, Math.max(1, Math.round(2 * u)))) {
    const ext = columnExtent(v, band, bit, 0.08, 34 * u);
    if (!ext) continue;
    const width = (ext.x1 - ext.x0) / u;
    if (width < 40 || width > 560) continue;
    const left = ext.x0 / u;
    if (opts.columnX !== undefined ? Math.abs(left - opts.columnX) > 40 : left < 20 || left > 300) continue;
    const box = { x0: ext.x0, x1: ext.x1, y0: band.y0, y1: band.y1 };
    const frac = fraction(v, box, bit);
    if (frac < 0.08 || frac > 0.65) continue;
    if (transitionDensity(v, box, bit) < 4) continue; // letters, not a blob
    out.push({ box, sig: signature(v, box, 24, 3) });
  }
  return out;
}

// ---------- KO streak banner ----------

export function bannerCandidates(v: View): Candidate[] {
  const u = v.u;
  const white = rowCounts(v, WHITE);
  const out: Candidate[] = [];
  for (const band of findBands(white, 30 * u, 16 * u, 80 * u, Math.max(1, Math.round(2 * u)))) {
    const ext = columnExtent(v, band, WHITE, 0.08, 40 * u);
    if (!ext) continue;
    const width = (ext.x1 - ext.x0) / u;
    if (width < 220 || width > 950) continue;
    const centre = (ext.x0 + ext.x1) / 2 / u;
    if (Math.abs(centre - v.w / u / 2) > 140) continue;
    const box = { x0: ext.x0, x1: ext.x1, y0: band.y0, y1: band.y1 };
    if (transitionDensity(v, box, WHITE) < 3) continue;
    const whiteFrac = fraction(v, box, WHITE);
    if (whiteFrac < 0.1 || whiteFrac > 0.7) continue;
    out.push({ box, sig: signature(v, box, 24, 3) });
  }
  return out;
}

// ---------- in-match HUD ----------

function longestRun(v: View, bit: number, y: number, x0: number, x1: number): number {
  let best = 0;
  let run = 0;
  const row = y * v.w;
  for (let x = x0; x < x1; x++) {
    if (v.mask[row + x] & bit) {
      run++;
      if (run > best) best = run;
    } else run = 0;
  }
  return best;
}

/** True when the top bar shows your team's blue on the left and the enemy's red on the right. */
export function matchHudVisible(v: View): boolean {
  const u = v.u;
  const mid = Math.floor(v.w / 2);
  let blue = 0;
  let red = 0;
  for (let y = 0; y < v.h; y++) {
    blue = Math.max(blue, longestRun(v, BLUE, y, 0, mid));
    red = Math.max(red, longestRun(v, RED, y, mid, v.w));
  }
  return blue >= 30 * u && red >= 30 * u;
}

// ---------- the analyzer: one frame in, observations out ----------

export interface AnalyzerOptions {
  frameMs: number;
  koColumnX?: number;
}

export class HudAnalyzer {
  private feed = new LineTracker({ confirmFrames: 2, matchDist: 0.45, stillMove: 6, slideX: 120, shiftY: 70, memoryMs: 9000, pendingMs: 450 });
  private ko = new LineTracker({ confirmFrames: 3, matchDist: 0.42, stillMove: 5, slideX: 90, shiftY: 70, memoryMs: 6000, pendingMs: 450 });
  private banner = new LineTracker({ confirmFrames: 2, matchDist: 0.45, stillMove: 12, slideX: 60, shiftY: 20, memoryMs: 2500, pendingMs: 450 });
  private wanted = new Set<RegionId>();
  frames = 0;
  totalMs = 0;

  constructor(private layout: HudLayout, private opts: AnalyzerOptions) {}

  setLayout(layout: HudLayout): void {
    this.layout = layout;
    this.feed.reset();
    this.ko.reset();
    this.banner.reset();
  }

  setKoColumn(x: number | undefined): void {
    this.opts.koColumnX = x;
  }

  /** Ask for a full crop of a region (map label, outcome text) with the next frame. */
  want(region: RegionId): void {
    this.wanted.add(region);
  }

  analyze(frame: Uint8Array, t: number): Observation[] {
    const started = Date.now();
    const out: Observation[] = [];
    const { frameMs } = this.opts;
    const feedView = viewFor(frame, this.layout, 'feed');
    for (const tr of this.feed.update(feedCandidates(feedView), t, feedView.u, frameMs))
      out.push({ kind: 'feed-row', t: tr.firstSeen, id: tr.id, box: tr.box, crop: cropLuma(feedView, tr.box) });

    const koView = viewFor(frame, this.layout, 'ko');
    for (const tr of this.ko.update(koCandidates(koView, { columnX: this.opts.koColumnX }), t, koView.u, frameMs))
      out.push({ kind: 'ko-line', t: tr.firstSeen, id: tr.id, box: tr.box, crop: cropLuma(koView, tr.box) });

    const bannerView = viewFor(frame, this.layout, 'banner');
    for (const tr of this.banner.update(bannerCandidates(bannerView), t, bannerView.u, frameMs))
      out.push({ kind: 'banner', t: tr.firstSeen, id: tr.id, box: tr.box, crop: cropLuma(bannerView, tr.box, 6) });

    const topView = viewFor(frame, this.layout, 'top');
    out.push({ kind: 'hud', t, matchHud: matchHudVisible(topView), feedRows: this.feed.onScreen(t, frameMs), koLines: this.ko.onScreen(t, frameMs) });

    for (const id of this.wanted) out.push({ kind: 'crop', t, region: id, crop: cropAll(viewFor(frame, this.layout, id)) });
    this.wanted.clear();

    this.frames++;
    this.totalMs += Date.now() - started;
    return out;
  }
}
