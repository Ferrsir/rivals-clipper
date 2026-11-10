import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { countdownInRgb, deadSpans, type DeadSample } from '../src/main/vision/death-screen';
import { judgeClip } from '../src/main/clip-check';
import { countdownVisible, deathCardVisible } from '../src/main/vision/detectors';
import { layoutFor, region } from '../src/main/vision/layout';
import { makeView } from '../src/main/vision/image';
import { DEATH_TEMPLATE } from '../src/main/vision/death-screen';

// 46x26 crops of the top left of Ferris's clips (2026-11-09): the countdown ("10s", "4s PAST LIVES", ...)
// and gameplay that looks a bit like it (objective text on a bright wall, a yellow streak, fire).
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, '../../test/fixtures/death-countdown.json'), 'utf8')) as Record<'countdown' | 'gameplay', Array<{ clip: string; i: number; rgb: string }>>;

test('the respawn countdown is found in real death frames', () => {
  for (const c of fx.countdown) assert.ok(countdownInRgb(Buffer.from(c.rgb, 'base64')), `${c.clip} #${c.i}`);
});

test('bright gameplay, objective text and yellow streaks are not the countdown', () => {
  for (const c of fx.gameplay) assert.ok(!countdownInRgb(Buffer.from(c.rgb, 'base64')), `${c.clip} #${c.i}`);
});

/** A BGRA mosaic for `layout` with one region filled from an rgb24 crop of the same size (or a function). */
function mosaicWith(layout: ReturnType<typeof layoutFor>, id: 'respawn' | 'deathcard', px: (x: number, y: number) => [number, number, number]) {
  const f = new Uint8Array(layout.mosaicW * layout.mosaicH * 4);
  const g = region(layout, id);
  for (let y = 0; y < g.outH; y++) for (let x = 0; x < g.outW; x++) {
    const [r, gr, b] = px(x, y);
    const o = ((g.outY + y) * layout.mosaicW + x) * 4;
    [f[o], f[o + 1], f[o + 2], f[o + 3]] = [b, gr, r, 255];
  }
  return { frame: f, g };
}

test('the live detector finds the countdown in its HUD region, on the ultrawide layout too', () => {
  for (const layout of [layoutFor(2584, 1080), layoutFor(3840, 1080, 1, undefined, 2.39), layoutFor(2560, 1440)]) {
    const g = region(layout, 'respawn');
    assert.deepEqual([g.outW, g.outH], [46, 26]);
    const rgb = Buffer.from(fx.countdown[0].rgb, 'base64');
    const { frame } = mosaicWith(layout, 'respawn', (x, y) => [rgb[(y * 46 + x) * 3], rgb[(y * 46 + x) * 3 + 1], rgb[(y * 46 + x) * 3 + 2]]);
    assert.ok(countdownVisible(makeView(frame, layout, g)));
    const bad = Buffer.from(fx.gameplay[0].rgb, 'base64');
    const { frame: f2 } = mosaicWith(layout, 'respawn', (x, y) => [bad[(y * 46 + x) * 3], bad[(y * 46 + x) * 3 + 1], bad[(y * 46 + x) * 3 + 2]]);
    assert.ok(!countdownVisible(makeView(f2, layout, g)));
  }
});

test('the live detector finds the DEFEATED BY card in its region', () => {
  const layout = layoutFor(2584, 1080);
  const g = region(layout, 'deathcard');
  const yellow: [number, number, number] = [235, 200, 40];
  const grey: [number, number, number] = [60, 60, 70];
  const { frame } = mosaicWith(layout, 'deathcard', (x, y) => (DEATH_TEMPLATE[Math.min(11, Math.floor((y * 12) / g.outH))][Math.min(63, Math.floor((x * 64) / g.outW))] === '#' ? yellow : grey));
  assert.ok(deathCardVisible(makeView(frame, layout, g)));
  const { frame: blank } = mosaicWith(layout, 'deathcard', () => grey);
  assert.ok(!deathCardVisible(makeView(blank, layout, g)));
});

/** Samples 4 per second for `seconds`, dead (countdown) between `from` and `to`. */
function samples(seconds: number, dead: Array<[number, number, boolean?]>): DeadSample[] {
  const out: DeadSample[] = [];
  for (let t = 0; t < seconds; t += 0.25) {
    const d = dead.find(([a, b]) => t >= a && t < b);
    out.push({ t, countdown: !!d, card: !!d && !!d[2] });
  }
  return out;
}

test('dead spans need two samples and bridge a scoreboard gap', () => {
  const s = samples(12, [[2, 2.25], [4, 5], [7, 8]]);
  const spans = deadSpans(s, 0.25);
  assert.equal(spans.length, 1, 'the lone sample at 2 s is ignored; 5-7 s is a scoreboard gap');
  assert.equal(spans[0].from, 4);
  assert.ok(spans[0].fresh);
});

test('a clip that runs on into your death is cut a second after it (22:33: kills at 3.3 and 4.5, died at 4.0)', () => {
  const v = judgeClip(samples(9.25, [[4, 9.25]]), [3.3, 4.5], 9.27);
  assert.equal(v.action, 'trim');
  assert.ok(v.action === 'trim' && v.untilSec >= 5 && v.untilSec <= 5.25, JSON.stringify(v));
});

test('a clip whose only kill is in the replay of your death is dropped (22:32, 22:30)', () => {
  // Dead from the first frame (countdown under the card), kill at 3.3 s.
  assert.equal(judgeClip(samples(8, [[0, 4, true]]), [3.3], 8).action, 'reject');
  // The scoreboard hid the countdown first; it shows at 3 s with the card, the kill is at 3.6 s.
  assert.equal(judgeClip(samples(8, [[3, 4.25, true], [5.75, 6.75, true]]), [3.6], 8).action, 'reject');
});

test('clips without a death screen are left alone', () => {
  assert.deepEqual(judgeClip(samples(18, []), [3.5, 5.7, 13.1], 18), { action: 'keep' });
});

test('a death before the kills (you respawned, then got them) leaves the clip alone', () => {
  assert.deepEqual(judgeClip(samples(10, [[0, 1.5]]), [3, 4], 10), { action: 'keep' });
});
