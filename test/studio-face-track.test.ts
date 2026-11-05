// "put his icon on gojo": the picture has to stay on the face through fast fight movement, not jump
// between the few frames the AI looked at.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type GreyFrames, simplifyKeys, smoothKeys, trackFace } from '../src/main/studio/facetrack';
import { faceAnchors } from '../src/main/studio/overlay';

/** A textured "face" moving on a curved path over a noisy background. */
function scene(n = 60, w = 320, h = 180, cut?: number): { g: GreyFrames; truth: Array<{ x: number; y: number }> } {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const bg = new Uint8Array(w * h).map(() => 60 + rnd() * 40);
  const face = Array.from({ length: 21 * 21 }, (_, i) => ((i % 21) * 9 + Math.floor(i / 21) * 5) % 255);
  const frames: Uint8Array[] = [];
  const truth: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < n; i++) {
    const f = Uint8Array.from(bg);
    const cx = Math.round(60 + (200 * i) / n);
    const cy = Math.round(90 + 50 * Math.sin((i / n) * Math.PI * 2));
    for (let y = 0; y < 21; y++) for (let x = 0; x < 21; x++) f[(cy - 10 + y) * w + (cx - 10 + x)] = face[y * 21 + x];
    if (cut !== undefined && i >= cut) f.fill(20, 0, w * 30);
    frames.push(f);
    truth.push({ x: cx / w, y: cy / h });
  }
  return { g: { w, h, fps: 15, start: 2, frames }, truth };
}

test('the picture follows the face between the AI sightings instead of sliding in a straight line', () => {
  const { g, truth } = scene();
  const at = (i: number) => ({ t: 2 + i / 15, x: truth[i].x, y: truth[i].y, size: 21 / 320 });
  const keys = trackFace(g, [at(0), at(59)]);
  assert.equal(keys.length, 60);
  let worst = 0;
  keys.forEach((k, i) => (worst = Math.max(worst, Math.hypot((k.x - truth[i].x) * 320, (k.y - truth[i].y) * 180))));
  assert.ok(worst < 4, `stays within a few pixels (worst ${worst.toFixed(1)} px)`);
  // A straight line between the two sightings would be ~50 px off at the top of the curve.
  const simple = simplifyKeys(keys);
  assert.ok(simple.length < keys.length && simple.length >= 4, `${simple.length} keys keep the curve`);
  assert.equal(simple[0].t, keys[0].t);
});

test('the AI corrects the tracker when it drifts onto something else', () => {
  const { g, truth } = scene();
  const at = (i: number, dx = 0) => ({ t: 2 + i / 15, x: truth[i].x + dx, y: truth[i].y, size: 21 / 320 });
  // The first sighting is off; the next ones are right, and the track snaps back to them.
  const keys = trackFace(g, [at(0, 0.15), at(20), at(40), at(59)]);
  for (const i of [21, 30, 45, 59]) assert.ok(Math.abs(keys[i].x - truth[i].x) * 320 < 4, `frame ${i} on the face`);
});

test('only confident AI sightings anchor the tracker', () => {
  const a = faceAnchors({ frames: [{ index: 0, x: 0.4, y: 0.3, size: 0.1, visible: true, confidence: 0.9 }, { index: 1, visible: false }, { index: 2, x: 0.5, y: 0.3, size: 0.1, visible: true, confidence: 0.2 }] }, [1, 2, 3]);
  assert.deepEqual(a.map((x) => x.t), [1]);
  const s = smoothKeys([{ t: 0, x: 0, y: 0, size: 0.1 }, { t: 1, x: 0.3, y: 0, size: 0.1 }, { t: 2, x: 0, y: 0, size: 0.1 }], 1);
  assert.ok(Math.abs(s[1].x - 0.1) < 1e-9);
});
