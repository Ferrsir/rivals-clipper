// Test helper: a synthetic music track with known tempo and drop.
import { ANALYSIS_RATE } from '../src/main/studio/beats';

/** Synthetic track: kick on every beat, hats on off-beats, quiet for `quietBars`, then loud with bass. */
export function synthTrack(bpm: number, seconds: number, opts: { quietBars?: number; offset?: number; sr?: number } = {}): Float32Array {
  const sr = opts.sr ?? ANALYSIS_RATE;
  const out = new Float32Array(Math.round(seconds * sr));
  const beat = 60 / bpm;
  const offset = opts.offset ?? 0.25;
  const dropAt = offset + (opts.quietBars ?? 0) * 4 * beat;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let b = 0; offset + b * beat < seconds; b++) {
    const t0 = offset + b * beat;
    const loud = t0 >= dropAt - 1e-6;
    const gain = loud ? 0.9 : 0.3;
    // Kick: decaying 55 Hz sine with a pitch sweep.
    for (let i = 0; i < 0.18 * sr; i++) {
      const idx = Math.round(t0 * sr) + i;
      if (idx >= out.length) break;
      const t = i / sr;
      const f = 55 + 120 * Math.exp(-t * 40);
      out[idx] += gain * Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 18) * (b % 4 === 0 ? 1 : 0.8);
    }
    // Hat on the off-beat.
    const th = t0 + beat / 2;
    for (let i = 0; i < 0.03 * sr; i++) {
      const idx = Math.round(th * sr) + i;
      if (idx >= out.length) break;
      out[idx] += 0.15 * rnd() * Math.exp(-(i / sr) * 120);
    }
  }
  // Sustained bass after the drop.
  for (let i = Math.round(dropAt * sr); i < out.length; i++) out[i] += 0.25 * Math.sin((2 * Math.PI * 49 * i) / sr);
  return out;
}

