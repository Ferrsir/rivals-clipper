// Signs on screen that you are dead, measured on Ferris's recordings (2026-11-09/10, 135 clips):
//
// - The respawn countdown: big yellow "10s", "9s", ... at the top left. It appears the moment you die
//   (the same frame your health hits 0) and stays until you respawn, also during the "PAST LIVES"
//   replay of your death. Under the Tab scoreboard it is dimmed and not found, which is fine: it was
//   seen before the scoreboard opened.
// - The "DEFEATED BY" card, bottom right, shown during the replay of your death (about 3 s in).
//
// While either is on screen, KOs in the HUD are not yours: the replay shows your killer's view, whose
// KO list has YOUR name in it, and the camera may follow a teammate. Clips also must not run on into
// these screens.
//
// Both checks work on small RGB crops so the same code runs on the live HUD mosaic and on saved clips.

/** Countdown crop, in fractions of the frame height from the left edge of the game picture. */
export const COUNTDOWN_CROP = { x: 0.02, y: 0.01, w: 0.23, h: 0.13 };
/** Countdown crop size in pixels after scaling (the measured thresholds below are for this size). */
export const COUNTDOWN_BOX = { w: 46, h: 26 };

/** Saturated HUD yellow (the countdown digits). Gameplay yellows are mostly paler or orange. */
export const isCountdownYellow = (r: number, g: number, b: number) => r > 190 && g > 150 && b < 110 && r - b > 110 && g >= 0.7 * r;

/**
 * True when a crop shows the respawn countdown. `yellow(x, y)` says whether a pixel of the w x h crop
 * is countdown yellow. The digits are tall strokes starting a little in from the left, with clear
 * margins above and below; bright scenery, objective text and yellow streaks fail at least one of those.
 * Measured on 135 clips at 46x26: 346 of 349 death frames found, no gameplay frames.
 */
export function countdownShape(yellow: (x: number, y: number) => boolean, w: number, h: number): boolean {
  const sx = w / COUNTDOWN_BOX.w;
  const sy = h / COUNTDOWN_BOX.h;
  const row = (r: number) => Math.round(r * sy);
  const col = (c: number) => Math.round(c * sx);
  const topEnd = row(3);
  const botStart = row(24);
  const coreX0 = col(1);
  const coreX1 = col(34);
  let top = 0;
  let bot = 0;
  let core = 0;
  const colCount = new Array<number>(w).fill(0);
  const rowCount = new Array<number>(h).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!yellow(x, y)) continue;
      if (y < topEnd) top++;
      else if (y >= botStart) bot++;
      else {
        colCount[x]++;
        if (x >= coreX0 && x < coreX1) core++;
      }
      if (x < coreX1) rowCount[y]++;
    }
  }
  const topFrac = top / Math.max(1, topEnd * w);
  const botFrac = bot / Math.max(1, (h - botStart) * w);
  const coreFrac = core / Math.max(1, (botStart - topEnd) * (coreX1 - coreX0));
  const left = colCount.findIndex((n) => n >= 3 * sy);
  const rowsUsed = rowCount.filter((n) => n >= 2 * sx).length;
  let tallest = 0;
  for (let x = col(3); x < col(13); x++) tallest = Math.max(tallest, colCount[x] ?? 0);
  return (
    topFrac <= 0.02 && botFrac <= 0.05 && coreFrac >= 0.08 && coreFrac <= 0.45 &&
    left >= col(3) && left <= col(8) && rowsUsed >= 12 * sy && tallest >= 9 * sy
  );
}

/** Countdown check on a packed rgb24 crop. */
export function countdownInRgb(rgb: Uint8Array, w = COUNTDOWN_BOX.w, h = COUNTDOWN_BOX.h): boolean {
  return countdownShape((x, y) => {
    const o = (y * w + x) * 3;
    return isCountdownYellow(rgb[o], rgb[o + 1], rgb[o + 2]);
  }, w, h);
}

// ---------- "DEFEATED BY" card ----------

/**
 * The "DEFEATED BY" card's title and frame as yellow pixels, 64x12, averaged over 11 death frames from
 * Ferris's footage. Its box: right edge 0.235 and left edge 0.43 of the frame height in from the
 * right, 0.685-0.725 of the height down (the HUD scales with the height).
 */
export const DEATH_TEMPLATE = [
  '#############################################...................',
  '#####...........................................................',
  '..##............................................................',
  '..##..................#..........##.............................',
  '..##...#..#..#...#...#.....##...##..#....#..#....#.##.#.#.......',
  '..##...#..#.##...#...#......#...#...#....#..#...##.#..##........',
  '..#...#...#.###..###.###..#.#...#...###.#...#...####...#........',
  '.##...#..#..#........#...####...#...#...#..#....#..#..#.........',
  '.##...####..###.#....###.#...#..#..####.###.....###...#.........',
  '.##.............................................................',
  '.#..............................................................',
  '.#..............................................................',
];
export const DEATH_BOX = { w: 64, h: 12 };
/** Card crop, in fractions of the frame height, measured in from the right edge of the game picture. */
export const DEATH_CROP = { xFromRight: 0.43, y: 0.685, w: 0.195, h: 0.04 };
export const DEATH_MIN = 0.45;
const tmpl = DEATH_TEMPLATE.map((r) => [...r].map((c) => c === '#'));

export const isCardYellow = (r: number, g: number, b: number) => r > 140 && g > 110 && r - b > 70;

/**
 * How well a crop matches the card (intersection over union of the yellow pixels, best of small
 * shifts). `yellow(x, y)` covers a w x h crop; it is compared cell by cell with the 64x12 template.
 * Measured: death frames 0.63-1.0, gameplay 0-0.26.
 */
export function deathScoreOf(yellow: (x: number, y: number) => boolean, width = DEATH_BOX.w, height = DEATH_BOX.h): number {
  const m: boolean[][] = [];
  for (let y = 0; y < height; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < width; x++) row.push(yellow(x, y));
    m.push(row);
  }
  let best = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      let inter = 0;
      let union = 0;
      for (let y = 0; y < DEATH_BOX.h; y++) {
        for (let x = 0; x < DEATH_BOX.w; x++) {
          const yy = y - dy;
          const xx = x - dx;
          const a = yy >= 0 && yy < height && xx >= 0 && xx < width && m[yy][xx];
          const t = tmpl[y][x];
          if (a && t) inter++;
          if (a || t) union++;
        }
      }
      best = Math.max(best, inter / Math.max(1, union));
    }
  }
  return best;
}

/** Card score of a packed rgb24 crop. */
export function deathScore(rgb: Uint8Array, width = DEATH_BOX.w, height = DEATH_BOX.h): number {
  return deathScoreOf((x, y) => {
    const o = (y * width + x) * 3;
    return isCardYellow(rgb[o], rgb[o + 1], rgb[o + 2]);
  }, width, height);
}

// ---------- ffmpeg crops of a saved clip (the recording is the game picture) ----------

/** `scale` is the in-game HUD scale setting (the live layout scales every HUD box with it the same way). */
export const countdownCropFilter = (scale = 1) => {
  const f = (v: number) => +(v * scale).toFixed(4);
  return `crop=w=trunc(ih*${f(COUNTDOWN_CROP.w)}/2)*2:h=trunc(ih*${f(COUNTDOWN_CROP.h)}/2)*2:x=trunc(ih*${f(COUNTDOWN_CROP.x)}/2)*2:y=trunc(ih*${f(COUNTDOWN_CROP.y)}/2)*2`;
};

/** Takes a w x h rgb24 box out of the left of rows `stride` pixels wide. */
export function unpad(strip: Uint8Array, stride: number, w: number, h: number): Uint8Array {
  const box = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) box.set(strip.subarray(y * stride * 3, y * stride * 3 + w * 3), y * w * 3);
  return box;
}

export const deathCropFilter = (scale = 1) => {
  const f = (v: number) => +(v * scale).toFixed(4);
  return `crop=w=trunc(ih*${f(DEATH_CROP.w)}/2)*2:h=trunc(ih*${f(DEATH_CROP.h)}/2)*2:x=iw-trunc(ih*${f(DEATH_CROP.xFromRight)}/2)*2:y=trunc(ih*${f(DEATH_CROP.y)}/2)*2`;
};

// ---------- reading a clip's timeline ----------

/** One sample of a saved clip. */
export interface DeadSample {
  t: number;
  countdown: boolean;
  card: boolean;
}

export interface DeadSpan {
  from: number;
  to: number;
  /** The span starts with the countdown and no card: you died right there (not before the footage or behind the scoreboard). */
  fresh: boolean;
}

/**
 * Times you were dead, from samples taken `step` seconds apart. A sign must hold for two samples in a row
 * (one odd frame isn't a death). Spans less than `bridge` seconds apart are one death: the Tab scoreboard
 * hides the countdown for a few seconds.
 */
export function deadSpans(samples: DeadSample[], step: number, bridge = 3): DeadSpan[] {
  const on = samples.map((s) => s.countdown || s.card);
  const spans: DeadSpan[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (!on[i] || !(on[i - 1] || on[i + 1])) continue;
    const t = samples[i].t;
    const last = spans[spans.length - 1];
    if (last && t - last.to <= bridge) last.to = t + step;
    else {
      // Fresh: the first sign is the countdown without the card, and the sample before it (if any) was clear.
      const fresh = samples[i].countdown && !samples[i].card && i > 0;
      spans.push({ from: t, to: t + step, fresh });
    }
  }
  return spans;
}
