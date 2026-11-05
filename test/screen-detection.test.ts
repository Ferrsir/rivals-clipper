import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineTracker, koCandidates, feedCandidates, matchHudVisible, type Candidate } from '../src/main/vision/detectors';
import { ScreenFusion, bestMap, nameSimilarity, type EventSink, type OcrResult } from '../src/main/vision/fusion';
import { findBands, signature, viewFor } from '../src/main/vision/image';
import { DEFAULT_REGIONS, hudFilterGraph, layoutFor, region, type HudLayout, type RegionId } from '../src/main/vision/layout';
import { prepareForOcr, otsu } from '../src/main/vision/ocr';
import { score } from '../src/main/vision/harness';
import { DetectionPipeline } from '../src/main/vision/pipeline';

// ---------- layout ----------

test('screen crops are released when text reading is disabled', async () => {
  const pipeline = new DetectionPipeline({ gameEvent: () => {}, infoUpdate: () => {} }, undefined,
    { layout: layoutFor(1920, 1080), frameMs: 100, ocr: false });
  // Reproduce many changing feed rows without depending on the HUD's pixel detector.
  let id = 0;
  pipeline.analyzer.analyze = (_frame, t) => [{ kind: 'feed-row', id: ++id, t, box: { x0: 0, y0: 0, x1: 100, y1: 20 },
    crop: { w: 100, h: 20, data: new Uint8Array(2000) } }];
  for (let i = 0; i < 1000; i++) await pipeline.processFrame(new Uint8Array(0), i * 100);
  const crops = (pipeline as unknown as { crops: Map<string, unknown> }).crops;
  assert.equal(crops.size, 0, 'disabled OCR must not retain a crop for every feed row');
});

test('HUD regions scale with the screen and stay anchored', () => {
  for (const [w, h] of [[1920, 1080], [2560, 1440], [3840, 2160], [3440, 1440]]) {
    const l = layoutFor(w, h);
    const feed = region(l, 'feed');
    const ko = region(l, 'ko');
    // The kill feed hugs the right edge, the KO list sits right of the centre.
    assert.ok(feed.srcX + feed.srcW <= w && feed.srcX + feed.srcW >= w - 30 * (h / 1440), `${w}x${h} feed`);
    assert.ok(ko.srcX > w / 2, `${w}x${h} ko`);
    // The mosaic is the same size at every resolution (it is measured in HUD units).
    assert.equal(l.mosaicW, layoutFor(2560, 1440).mosaicW);
  }
});

test('HUD scale moves the regions with it', () => {
  const big = region(layoutFor(2560, 1440, 1.2), 'ko');
  const normal = region(layoutFor(2560, 1440, 1), 'ko');
  assert.ok(big.srcX > normal.srcX);
  assert.ok(big.srcW > normal.srcW);
});

test('ffmpeg graph crops every region and stacks them', () => {
  const g = hudFilterGraph(layoutFor(2560, 1440), { gpuFrames: true, fps: 10 });
  assert.match(g, /^\[0:v\]hwdownload,format=bgra,split=7/);
  assert.equal((g.match(/crop=/g) ?? []).length, DEFAULT_REGIONS.length);
  assert.match(g, /vstack=inputs=7\[hud\]$/);
});

// ---------- synthetic HUD frames ----------

type Rgb = [number, number, number];

function blankFrame(l: HudLayout, rgb: Rgb = [40, 45, 55]): Uint8Array {
  const f = new Uint8Array(l.mosaicW * l.mosaicH * 4);
  for (let i = 0; i < f.length; i += 4) [f[i], f[i + 1], f[i + 2], f[i + 3]] = [rgb[2], rgb[1], rgb[0], 255];
  return f;
}

/** Paints a rectangle inside one region, in that region's mosaic pixels. */
function paint(f: Uint8Array, l: HudLayout, id: RegionId, x0: number, y0: number, w: number, h: number, rgb: Rgb): void {
  const g = region(l, id);
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) {
      const p = ((g.outY + y) * l.mosaicW + x) * 4;
      [f[p], f[p + 1], f[p + 2]] = [rgb[2], rgb[1], rgb[0]];
    }
}

/** Something text-like: vertical strokes with gaps, `chars` letters wide. */
function paintText(f: Uint8Array, l: HudLayout, id: RegionId, x0: number, y0: number, chars: number, h: number, rgb: Rgb, seed = 1): void {
  let x = x0;
  for (let c = 0; c < chars; c++) {
    const strokes = 2 + ((c * 7 + seed) % 2);
    for (let s = 0; s < strokes; s++) {
      paint(f, l, id, x, y0, 2, h, rgb);
      x += 4;
    }
    paint(f, l, id, x - 8, y0, 6, 2, rgb); // a crossbar, so letters differ
    x += 3;
  }
}

const WHITE: Rgb = [245, 245, 245];
const L = layoutFor(2560, 1440);

test('a name without a KO badge cannot start a clip', () => {
  const f = blankFrame(L);
  const u = region(L, 'ko').pxPerUnit;
  paintText(f, L, 'ko', Math.round(60 * u), Math.round(120 * u), 9, Math.round(22 * u), WHITE);
  const c = koCandidates(viewFor(f, L, 'ko'));
  assert.ok(!c.some(line => line.strong));
});

test('a solid white block is not text', () => {
  const f = blankFrame(L);
  const u = region(L, 'ko').pxPerUnit;
  paint(f, L, 'ko', Math.round(60 * u), Math.round(120 * u), Math.round(200 * u), Math.round(22 * u), WHITE);
  assert.equal(koCandidates(viewFor(f, L, 'ko')).length, 0);
});

test('a faded older KO line is followed but marked weak', () => {
  const f = blankFrame(L);
  const u = region(L, 'ko').pxPerUnit;
  paintText(f, L, 'ko', Math.round(60 * u), Math.round(80 * u), 8, Math.round(22 * u), [170, 170, 170]);
  const c = koCandidates(viewFor(f, L, 'ko'));
  assert.equal(c.length, 1);
  assert.equal(c[0].strong, false);
});

test('a light kill-feed row with dark names is one of your rows', () => {
  const f = blankFrame(L);
  const u = region(L, 'feed').pxPerUnit;
  const x0 = Math.round(300 * u);
  const y0 = Math.round(60 * u);
  paint(f, L, 'feed', x0, y0, Math.round(440 * u), Math.round(34 * u), [225, 225, 225]);
  paintText(f, L, 'feed', x0 + 10, y0 + Math.round(8 * u), 8, Math.round(18 * u), [20, 20, 20]);
  paintText(f, L, 'feed', x0 + Math.round(260 * u), y0 + Math.round(8 * u), 6, Math.round(18 * u), [20, 20, 20], 3);
  assert.equal(feedCandidates(viewFor(f, L, 'feed')).length, 1);
});

test('the match bar needs both team colours', () => {
  const f = blankFrame(L);
  const g = region(L, 'top');
  const u = g.pxPerUnit;
  paint(f, L, 'top', Math.round(400 * u), Math.round(60 * u), Math.round(120 * u), 6, [40, 120, 240]);
  assert.equal(matchHudVisible(viewFor(f, L, 'top')), false);
  paint(f, L, 'top', Math.round(920 * u), Math.round(60 * u), Math.round(120 * u), 6, [235, 60, 40]);
  assert.equal(matchHudVisible(viewFor(f, L, 'top')), true);
});

test('the KO icon (crossed blades) and the assist icon (figure on a ring) are told apart', () => {
  const f = blankFrame(L);
  const g = region(L, 'ko');
  const u = g.pxPerUnit;
  const s = Math.round(22 * u); // icon size
  const X = (x0: number, y0: number) => {
    for (let i = 0; i < s; i++) {
      paint(f, L, 'ko', x0 + i, y0 + i, 2, 1, WHITE);
      paint(f, L, 'ko', x0 + s - 1 - i, y0 + i, 2, 1, WHITE);
    }
  };
  const figure = (x0: number, y0: number) => {
    paint(f, L, 'ko', x0 + Math.round(s / 2) - 2, y0, 4, 4, WHITE); // head
    paint(f, L, 'ko', x0 + Math.round(s / 2) - 1, y0 + 4, 2, Math.round(s * 0.45), WHITE); // body
    paint(f, L, 'ko', x0, y0 + s - 5, s, 2, WHITE); // ring
    paint(f, L, 'ko', x0 + 2, y0 + s - 3, s - 4, 3, WHITE);
  };
  const x0 = Math.round(60 * u);
  X(x0, 40);
  paintText(f, L, 'ko', x0 + s + 8, 42, 8, s - 4, WHITE);
  figure(x0, 140);
  paintText(f, L, 'ko', x0 + s + 8, 142, 8, s - 4, WHITE, 2);
  const c = koCandidates(viewFor(f, L, 'ko')).sort((a, b) => a.box.y0 - b.box.y0);
  assert.equal(c.length, 2);
  assert.equal(c[0].assist, false);
  assert.equal(c[1].assist, true);
});

// ---------- line tracking ----------

function cand(x: number, y: number, w: number, sigSeed: number, strong = true): Candidate {
  const sig = new Float32Array(72);
  for (let i = 0; i < sig.length; i++) sig[i] = Math.sin(i * (0.3 + sigSeed * 0.71) + sigSeed);
  return { box: { x0: x, y0: y, x1: x + w, y1: y + 20 }, sig, strong };
}

const TRACK = { confirmFrames: 3, matchDist: 0.42, stillMove: 5, slideX: 90, shiftY: 70, memoryMs: 6000, pendingMs: 450 };

test('a line is reported once, after it stops moving', () => {
  const tr = new LineTracker(TRACK);
  const out: number[] = [];
  // Slides in from the right over two frames, then sits still.
  const xs = [120, 60, 50, 50, 50, 50, 50, 50];
  xs.forEach((x, i) => out.push(tr.update([cand(x, 100, 200, 1)], i * 100, 1, 100).length));
  assert.equal(out.reduce((a, b) => a + b, 0), 1);
  assert.equal(out.indexOf(1), 4); // still at 2, 3, 4
});

test('an old line moving up does not hide the new line in its place', () => {
  const tr = new LineTracker(TRACK);
  let reported = 0;
  for (let i = 0; i < 5; i++) reported += tr.update([cand(50, 100, 200, 1)], i * 100, 1, 100).length;
  assert.equal(reported, 1);
  // A new KO: the old line moves up 30 px and fades; the new one appears where it was.
  for (let i = 5; i < 12; i++) reported += tr.update([cand(50, 70, 200, 1, false), cand(50, 100, 180, 2)], i * 100, 1, 100).length;
  assert.equal(reported, 2);
});

test('a line only ever seen faded is not a new KO', () => {
  const tr = new LineTracker(TRACK);
  let reported = 0;
  for (let i = 0; i < 10; i++) reported += tr.update([cand(50, 100, 200, 3, false)], i * 100, 1, 100).length;
  assert.equal(reported, 0);
});

test('a line that flickers off for a frame is not counted twice', () => {
  const tr = new LineTracker(TRACK);
  let reported = 0;
  const frames = [1, 1, 1, 1, 0, 1, 1, 1, 1];
  frames.forEach((on, i) => (reported += tr.update(on ? [cand(50, 100, 200, 4)] : [], i * 100, 1, 100).length));
  assert.equal(reported, 1);
});

test('band finding allows short gaps and rejects tall runs', () => {
  const counts = [0, 5, 5, 0, 5, 5, 0, 0, 0, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 0];
  assert.deepEqual(findBands(counts, 3, 2, 6, 1), [{ y0: 1, y1: 6 }]);
});

test('fingerprints ignore brightness but not content', () => {
  const f = blankFrame(L);
  const u = region(L, 'ko').pxPerUnit;
  paintText(f, L, 'ko', 40, 40, 8, 16, WHITE, 1);
  paintText(f, L, 'ko', 40, 120, 8, 16, WHITE, 2);
  const v = viewFor(f, L, 'ko');
  const a = signature(v, { x0: 40, y0: 40, x1: 140, y1: 56 }, 24, 3);
  const b = signature(v, { x0: 40, y0: 120, x1: 140, y1: 136 }, 24, 3);
  assert.ok(u > 0);
  assert.ok(a.some((x, i) => Math.abs(x - b[i]) > 0.1));
});

// ---------- fusion: observations to game events ----------

interface Ev {
  key: string;
  value: unknown;
  at: number;
}

function harness(opts: { name?: string; ocr?: boolean; hudVerified?: boolean } = {}) {
  const events: Ev[] = [];
  const info: Array<[string, unknown]> = [];
  const ocrReqs: Array<{ id: number; kind: string }> = [];
  const sink: EventSink = {
    gameEvent: (key, value, at) => events.push({ key, value, at }),
    infoUpdate: (_f, key, value) => info.push([key, value]),
  };
  const fusion = new ScreenFusion(sink, { ocr: opts.ocr ?? true, playerName: opts.name, hudVerified: opts.hudVerified }, { requestOcr: (r) => ocrReqs.push(r) });
  const empty = { w: 0, h: 0, data: new Uint8Array(0) };
  const box = { x0: 0, y0: 0, x1: 1, y1: 1 };
  return {
    fusion,
    events,
    info,
    ocrReqs,
    hud(t: number, on: boolean) {
      fusion.onObservation({ kind: 'hud', t, matchHud: on, feedRows: 0, koLines: 0 });
      fusion.tick(t);
    },
    ko(t: number, id: number, assist = false) {
      fusion.onObservation({ kind: 'ko-line', t, id, box, crop: empty, assist });
    },
    feed(t: number, id: number) {
      fusion.onObservation({ kind: 'feed-row', t, id, box, crop: empty });
    },
    banner(t: number, id: number) {
      fusion.onObservation({ kind: 'banner', t, id, box, crop: empty });
    },
    kills: () => events.filter((e) => e.key === 'kill'),
    deaths: () => events.filter((e) => e.key === 'death'),
  };
}

const words = (...ws: Array<[string, number]>): OcrResult => ({
  text: ws.map((w) => w[0]).join(' '),
  words: ws.map(([text, x]) => ({ text, x0: x, x1: x + 60, conf: 90 })),
});

function inMatch(h: ReturnType<typeof harness>, from = 0) {
  for (let t = from; t < from + 500; t += 100) h.hud(t, true);
}

test('match bar appearing starts a match', () => {
  const h = harness();
  inMatch(h);
  assert.equal(h.events.filter((e) => e.key === 'match_start').length, 1);
});

test('a KO-list name is a kill, with the victim read from it', () => {
  const h = harness({ name: 'Leithl' });
  inMatch(h);
  h.ko(1000, 1);
  h.fusion.onOcr('ko', 1, words(['Valka', 10]), 1200);
  const k = h.kills();
  assert.equal(k.length, 1);
  assert.equal(k[0].at, 1000);
  const feed = h.events.find((e) => e.key === 'kill_feed')!.value as { attacker: string; victim: string };
  assert.deepEqual([feed.attacker, feed.victim], ['Leithl', 'Valka']);
});

test('the KO list and kill feed showing the same KO count once', () => {
  const h = harness({ name: 'Leithl' });
  inMatch(h);
  h.ko(1000, 1);
  h.feed(1200, 2);
  h.fusion.onOcr('ko', 1, words(['Valka', 10]), 1300);
  h.fusion.onOcr('feed', 2, words(['Leithl', 10], ['Valka', 300]), 1400);
  h.fusion.tick(5000);
  assert.equal(h.kills().length, 1);
  assert.equal(h.deaths().length, 0);
});

test('your name on the right of a feed row is a death', () => {
  const h = harness({ name: 'Leithl' });
  inMatch(h);
  h.feed(2000, 5);
  h.fusion.onOcr('feed', 5, words(['Valka', 10], ['Leithl', 300]), 2200);
  h.fusion.tick(6000);
  assert.equal(h.deaths().length, 1);
  assert.equal(h.kills().length, 0);
});

test('a trade (you KO them as they KO you) counts the kill and the death', () => {
  const h = harness({ name: 'Leithl' });
  inMatch(h);
  h.ko(3000, 1);
  h.feed(3100, 2);
  h.fusion.onOcr('ko', 1, words(['Valka', 10]), 3200);
  h.fusion.onOcr('feed', 2, words(['Valka', 10], ['Leithl', 300]), 3300);
  h.fusion.tick(8000);
  assert.equal(h.kills().length, 1);
  assert.equal(h.deaths().length, 1);
});

test('a KO-list line with the assist icon is an assist, not a kill', () => {
  const h = harness({ name: 'Leithl' });
  inMatch(h);
  h.ko(1000, 1, true);
  h.fusion.onOcr('ko', 1, words(['BooBoB', 10]), 1200);
  h.fusion.tick(3000);
  assert.equal(h.kills().length, 0);
  assert.deepEqual(h.events.filter((e) => e.key === 'assist').map((e) => e.value), [{ victim: 'BooBoB' }]);
});

test('the same name KO\'d twice within a few seconds is one KO shown twice', () => {
  const h = harness({ name: 'Leithl' });
  inMatch(h);
  h.ko(1000, 1);
  h.fusion.onOcr('ko', 1, words(['BALLADS1', 10]), 1200);
  h.ko(3500, 2);
  h.fusion.onOcr('ko', 2, words(['BALLADSI', 10]), 3700);
  h.ko(12_000, 3);
  h.fusion.onOcr('ko', 3, words(['BALLADS1', 10]), 12_200);
  assert.equal(h.kills().length, 2);
});

test('without your name a feed row alone claims nothing', () => {
  const h = harness();
  inMatch(h);
  h.feed(2000, 5);
  h.fusion.onOcr('feed', 5, words(['Somebody', 10], ['Else', 300]), 2200);
  h.fusion.tick(9000);
  assert.equal(h.kills().length + h.deaths().length, 0);
});

test('your name is learned from the word in all of your feed rows', () => {
  const h = harness();
  inMatch(h);
  const victims = ['Valka', 'Mokka', 'Zed', 'Pyro'];
  victims.forEach((v, i) => {
    h.feed(1000 + i * 3000, 10 + i);
    h.fusion.onOcr('feed', 10 + i, words(['Leithl', 10], [v, 300]), 1100 + i * 3000);
  });
  assert.equal(h.fusion.playerName, 'Leithl');
  assert.ok(h.info.some(([k, v]) => k === 'player_name' && v === 'Leithl'));
});

test('a streak banner with recognized text adds the missed kill', () => {
  const h = harness({ name: 'Leithl' });
  inMatch(h);
  h.banner(4000, 9);
  h.fusion.onOcr('banner', 9, {text: '5 PLAYER KO STREAK!', words: []}, 4100);
  h.fusion.tick(6000);
  assert.equal(h.kills().length, 1);
});

test('a streak banner right after a KO is not another kill', () => {
  const h = harness({ name: 'Leithl', ocr: false });
  inMatch(h);
  h.ko(4000, 1);
  h.fusion.tick(4800);
  h.banner(4300, 9);
  h.fusion.tick(7000);
  assert.equal(h.kills().length, 1);
});

test('kills with no match bar, once the bar is known to work, are the Practice Range', () => {
  const h = harness({ name: 'Leithl', ocr: false, hudVerified: true });
  h.hud(0, false);
  h.ko(100_000, 1);
  h.fusion.tick(101_000);
  assert.ok(h.info.some(([k, v]) => k === 'game_type' && v === 'Practice'));
  const types = h.events.map((e) => e.key);
  assert.ok(types.indexOf('match_start') < types.indexOf('kill'));
});

test('the match ends when the bar has been gone for a while', () => {
  const h = harness({ ocr: false });
  inMatch(h);
  for (let t = 600; t < 50_000; t += 1000) h.hud(t, false);
  assert.equal(h.events.filter((e) => e.key === 'match_end').length, 1);
});

test('VICTORY on screen ends the match with the result', () => {
  const h = harness();
  inMatch(h);
  h.fusion.onOcr('outcome', 1, { text: 'VICTORY', words: [] }, 9000);
  assert.ok(h.info.some(([k, v]) => k === 'match_outcome' && v === 'Victory'));
  assert.equal(h.events.filter((e) => e.key === 'match_end').length, 1);
});

test('map names are matched even when cut off or misread', () => {
  assert.ok(bestMap('Hall of Djalia'));
  assert.equal(bestMap('xx'), undefined);
  assert.ok(nameSimilarity('Leith1', 'Leithl') >= 0.8);
  assert.ok(nameSimilarity('Valka', 'Leithl') < 0.5);
});

// ---------- text reading prep ----------

test('OCR prep makes black text on white at a readable size', () => {
  const crop = { w: 20, h: 10, data: new Uint8Array(200).fill(30) };
  for (let x = 5; x < 15; x++) for (let y = 3; y < 7; y++) crop.data[y * 20 + x] = 250;
  const pgm = prepareForOcr(crop, 'light-text');
  const header = pgm.subarray(0, 20).toString('ascii');
  assert.match(header, /^P5\n\d+ \d+\n255\n/);
  assert.ok(otsu(crop.data) >= 30 && otsu(crop.data) < 250);
});

// ---------- harness scoring ----------

test('harness scoring pairs detections with labels within the tolerance', () => {
  const s = score([10.2, 15, 30.5], [10, 20, 30]);
  assert.equal(s.truePositives, 2);
  assert.equal(s.falsePositives, 1);
  assert.deepEqual(s.missedAt, [20]);
  assert.equal(s.meanLatencyMs, 350);
});
