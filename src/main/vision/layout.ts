// Where Marvel Rivals draws the HUD elements the screen detector reads, for any resolution.
//
// Positions are in "HUD units": 1 unit = 1 pixel on a 1440p screen (screen height / 1440). The game
// anchors its HUD to the screen edges and centre, so each region is measured from an anchor:
// the left edge, the centre line or the right edge. That keeps regions right on 1080p, 1440p, 4K and
// ultrawide screens. `hudScale` covers a smaller or larger in-game HUD.
//
// The regions are deliberately generous; the detectors find the exact rows inside them.
// They were measured from gameplay footage at default HUD settings and can be tuned per player with
// a calibration file (see docs/local-mode.md).

export type RegionId = 'feed' | 'ko' | 'banner' | 'top' | 'map' | 'outcome' | 'subtitle' | 'portrait';
export type Anchor = 'left' | 'center' | 'right';

export interface RegionSpec {
  id: RegionId;
  anchor: Anchor;
  /** Left edge, measured from the anchor in HUD units (negative = left of it). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Output pixels per HUD unit. Text regions get more detail than colour-only regions. */
  scale: number;
}

export const DEFAULT_REGIONS: RegionSpec[] = [
  { id: 'portrait', anchor: 'left', x: 83, y: 1220, w: 136, h: 140, scale: 0.25 },
  { id: 'subtitle', anchor: 'center', x: -600, y: 1070, w: 1400, h: 90, scale: 1.5 },
  // Kill feed, top right. Rows where you are involved have a light background.
  { id: 'feed', anchor: 'right', x: -780, y: 30, w: 760, h: 420, scale: 0.75 },
  // Your KOs, listed to the right of the crosshair ("✦ PlayerName").
  { id: 'ko', anchor: 'center', x: 200, y: 340, w: 640, h: 360, scale: 0.75 },
  // "5 PLAYER KO STREAK!" above the crosshair.
  { id: 'banner', anchor: 'center', x: -520, y: 290, w: 1040, h: 190, scale: 0.5 },
  // Round, timer and the blue/red objective bars: only shown in a real match.
  { id: 'top', anchor: 'center', x: -720, y: 0, w: 1440, h: 210, scale: 0.4 },
  // Map / objective label, top left.
  { id: 'map', anchor: 'left', x: 10, y: 20, w: 720, h: 150, scale: 0.6 },
  // VICTORY / DEFEAT.
  { id: 'outcome', anchor: 'center', x: -800, y: 380, w: 1600, h: 520, scale: 0.3 },
];

export interface RegionGeom {
  id: RegionId;
  /** Source rectangle in screen pixels. */
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
  /** Size in the mosaic the detector receives. */
  outW: number;
  outH: number;
  /** Top of this region inside the mosaic. */
  outY: number;
  /** Mosaic pixels per HUD unit (the HUD scale is already divided out), so detectors work in HUD units. */
  pxPerUnit: number;
}

export interface HudLayout {
  screenW: number;
  screenH: number;
  hudScale: number;
  mosaicW: number;
  mosaicH: number;
  regions: RegionGeom[];
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function layoutFor(screenW: number, screenH: number, hudScale = 1, specs: RegionSpec[] = DEFAULT_REGIONS, gameAspect = 0): HudLayout {
  const unit = screenH / 1440; // screen px per HUD unit at scale 1
  const playWidth = gameAspect > 0 ? Math.min(screenW, screenH * gameAspect) : screenW;
  const inset = (screenW - playWidth) / 2;
  const regions: RegionGeom[] = [];
  let y = 0;
  let maxW = 0;
  for (const s of specs) {
    const u = unit * hudScale;
    const anchorX = s.anchor === 'left' ? inset : s.anchor === 'center' ? screenW / 2 : screenW - inset;
    let x0 = anchorX + s.x * u;
    let y0 = s.y * u;
    let w = s.w * u;
    let h = s.h * u;
    // Keep inside the screen.
    x0 = Math.max(0, Math.min(screenW - 2, x0));
    y0 = Math.max(0, Math.min(screenH - 2, y0));
    w = Math.min(w, screenW - x0);
    h = Math.min(h, screenH - y0);
    const srcX = Math.floor(x0 / 2) * 2;
    const srcY = Math.floor(y0 / 2) * 2;
    const srcW = Math.max(2, Math.floor(w / 2) * 2);
    const srcH = Math.max(2, Math.floor(h / 2) * 2);
    // Output size is fixed in HUD units, so detector thresholds don't depend on the screen resolution.
    const outW = even(s.w * s.scale * Math.min(1, w / (s.w * u)));
    const outH = even(s.h * s.scale * Math.min(1, h / (s.h * u)));
    regions.push({ id: s.id, srcX, srcY, srcW, srcH, outW, outH, outY: y, pxPerUnit: s.scale });
    y += outH;
    maxW = Math.max(maxW, outW);
  }
  return { screenW, screenH, hudScale, mosaicW: even(maxW), mosaicH: y, regions };
}

export function region(layout: HudLayout, id: RegionId): RegionGeom {
  const r = layout.regions.find((g) => g.id === id);
  if (!r) throw new Error(`no region ${id}`);
  return r;
}

/**
 * ffmpeg filter graph that cuts the regions out of the screen and stacks them into one frame.
 * `input` is the ffmpeg label of the source; GPU frames from ddagrab are downloaded first.
 */
export function hudFilterGraph(layout: HudLayout, opts: { gpuFrames: boolean; fps: number; input?: string }): string {
  const src = opts.input ?? '0:v';
  const n = layout.regions.length;
  const head = `[${src}]${opts.gpuFrames ? '' : `fps=${opts.fps},`}${opts.gpuFrames ? 'hwdownload,' : ''}format=bgra,split=${n}${layout.regions.map((_, i) => `[s${i}]`).join('')}`;
  const parts = layout.regions.map(
    (r, i) =>
      `[s${i}]crop=${r.srcW}:${r.srcH}:${r.srcX}:${r.srcY},scale=${r.outW}:${r.outH}:flags=area,pad=${layout.mosaicW}:${r.outH}:0:0:black[r${i}]`,
  );
  const stack = `${layout.regions.map((_, i) => `[r${i}]`).join('')}vstack=inputs=${n}[hud]`;
  return [head, ...parts, stack].join(';');
}
