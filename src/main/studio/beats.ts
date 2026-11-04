// Music analysis: tempo, beat grid, downbeats, drops and energy, from mono PCM samples.
// Pure TypeScript (no native deps) so it runs the same on Windows and in tests.
//
// Method: spectral-flux onset envelope -> tempo from autocorrelation with a tempo prior ->
// dynamic-programming beat tracker (Ellis 2007) -> bar phase from low-frequency onsets ->
// drops where the loudness and bass jump between bars.

import type { MusicAnalysis } from '../../shared/studio';

export const ANALYSIS_RATE = 11025;
const FRAME = 512;
const HOP = 128;

// ---------- FFT ----------

class FFT {
  private rev: Uint32Array;
  private cos: Float64Array;
  private sin: Float64Array;
  constructor(private n: number) {
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
  }
  /** In-place complex FFT. */
  run(re: Float64Array, im: Float64Array): void {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step];
          const s = this.sin[k * step];
          const a = start + k;
          const b = a + half;
          const tr = re[b] * c - im[b] * s;
          const ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }
}

// ---------- features ----------

export interface Features {
  frameRate: number;
  onset: Float64Array;
  lowOnset: Float64Array;
  rms: Float64Array;
  low: Float64Array;
}

export function computeFeatures(samples: Float32Array, sr = ANALYSIS_RATE): Features {
  const pad = FRAME / 2;
  const nFrames = Math.max(1, Math.floor(samples.length / HOP) + 1);
  const fft = new FFT(FRAME);
  const win = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  const bins = FRAME / 2 + 1;
  const lowBin = Math.max(2, Math.round((160 * FRAME) / sr));
  const maxBin = Math.min(bins - 1, Math.round((5000 * FRAME) / sr));
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);
  const onset = new Float64Array(nFrames);
  const lowOnset = new Float64Array(nFrames);
  const rms = new Float64Array(nFrames);
  const low = new Float64Array(nFrames);

  for (let f = 0; f < nFrames; f++) {
    const start = f * HOP - pad;
    let sq = 0;
    for (let i = 0; i < FRAME; i++) {
      const idx = start + i;
      const v = idx >= 0 && idx < samples.length ? samples[idx] : 0;
      sq += v * v;
      re[i] = v * win[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(sq / FRAME);
    fft.run(re, im);
    let flux = 0;
    let lowFlux = 0;
    let lowE = 0;
    for (let k = 1; k <= maxBin; k++) {
      const mag = Math.hypot(re[k], im[k]);
      const lm = Math.log1p(100 * mag);
      cur[k] = lm;
      const d = lm - prev[k];
      if (d > 0) {
        flux += d;
        if (k <= lowBin) lowFlux += d;
      }
      if (k <= lowBin) lowE += mag * mag;
    }
    onset[f] = f === 0 ? 0 : flux;
    lowOnset[f] = f === 0 ? 0 : lowFlux;
    low[f] = Math.sqrt(lowE);
    const t = prev;
    prev = cur;
    cur = t;
  }
  return { frameRate: sr / HOP, onset: normalizeOnset(onset, sr), lowOnset: normalizeOnset(lowOnset, sr), rms, low };
}

/** Remove the slow-moving average and scale to unit standard deviation. */
function normalizeOnset(o: Float64Array, sr: number): Float64Array {
  const w = Math.round((0.4 * sr) / HOP);
  const out = new Float64Array(o.length);
  let acc = 0;
  const q: number[] = [];
  for (let i = 0; i < o.length; i++) {
    q.push(o[i]);
    acc += o[i];
    if (q.length > w) acc -= q.shift()!;
    const mean = acc / q.length;
    out[i] = Math.max(0, o[i] - mean);
  }
  let s = 0;
  for (const v of out) s += v * v;
  const sd = Math.sqrt(s / Math.max(1, out.length)) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= sd;
  return out;
}

// ---------- tempo ----------

function autocorr(o: Float64Array, lag: number): number {
  const L = Math.floor(lag);
  const frac = lag - L;
  let a = 0;
  let b = 0;
  for (let t = L + 1; t < o.length; t++) {
    a += o[t] * o[t - L];
    b += o[t] * o[t - L - 1];
  }
  const n = Math.max(1, o.length - L);
  return ((1 - frac) * a + frac * b) / n;
}

export function estimateTempo(onset: Float64Array, frameRate: number, prior = 125): { bpm: number; period: number; confidence: number } {
  const minBpm = 60;
  const maxBpm = 200;
  const lagMin = Math.floor((60 * frameRate) / maxBpm);
  const lagMax = Math.ceil((60 * frameRate) / minBpm);
  const r0 = autocorr(onset, 0) || 1;
  let best = lagMin;
  let bestScore = -Infinity;
  const scores: number[] = [];
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const bpm = (60 * frameRate) / lag;
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / prior) / 0.9, 2));
    const r = autocorr(onset, lag) + 0.5 * (2 * lag < onset.length ? autocorr(onset, 2 * lag) : 0);
    const sc = r * w;
    scores[lag] = sc;
    if (sc > bestScore) {
      bestScore = sc;
      best = lag;
    }
  }
  // Parabolic refinement around the integer peak.
  let period = best;
  const a = scores[best - 1];
  const c = scores[best + 1];
  if (a !== undefined && c !== undefined) {
    const denom = a - 2 * bestScore + c;
    if (denom < 0) period = best + (0.5 * (a - c)) / denom;
  }
  const confidence = Math.max(0, Math.min(1, autocorr(onset, period) / r0 / 0.5));
  return { bpm: (60 * frameRate) / period, period, confidence };
}

// ---------- beat tracking ----------

export function trackBeats(onset: Float64Array, period: number, tightness = 100): number[] {
  const n = onset.length;
  if (n < 4 || period < 2) return [];
  // Smooth the onset envelope with a Gaussian about 1/32 of a beat wide.
  const sigma = period / 32;
  const half = Math.ceil(3 * sigma);
  const kern: number[] = [];
  for (let i = -half; i <= half; i++) kern.push(Math.exp(-0.5 * (i / sigma) ** 2));
  const local = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    let s = 0;
    for (let k = -half; k <= half; k++) {
      const j = t + k;
      if (j >= 0 && j < n) s += onset[j] * kern[k + half];
    }
    local[t] = s;
  }
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(2 * period);
  for (let t = 0; t < n; t++) {
    let best = 0;
    let arg = -1;
    for (let tau = t - hi; tau <= t - lo; tau++) {
      if (tau < 0) continue;
      const pen = Math.log((t - tau) / period);
      const v = score[tau] - tightness * pen * pen;
      if (arg < 0 || v > best) {
        best = v;
        arg = tau;
      }
    }
    score[t] = local[t] + (arg >= 0 ? Math.max(0, best) : 0);
    back[t] = arg >= 0 && best > 0 ? arg : -1;
  }
  // End on the best score in the last beat period.
  let end = n - 1;
  let endScore = -Infinity;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) {
    if (score[t] > endScore) {
      endScore = score[t];
      end = t;
    }
  }
  const frames: number[] = [];
  for (let t = end; t >= 0; t = back[t]) {
    frames.push(t);
    if (back[t] < 0) break;
  }
  frames.reverse();
  // Drop weak beats at the very start and end (silence, fade-outs).
  const mean = frames.reduce((s, f) => s + local[f], 0) / Math.max(1, frames.length);
  let a = 0;
  let b = frames.length - 1;
  while (a < b && local[frames[a]] < 0.2 * mean) a++;
  while (b > a && local[frames[b]] < 0.2 * mean) b--;
  // The very first and last beats drift when the file starts or ends mid-beat.
  while (b - a > 4 && Math.abs(frames[a + 1] - frames[a] - period) > 0.06 * period) a++;
  while (b - a > 4 && Math.abs(frames[b] - frames[b - 1] - period) > 0.06 * period) b--;
  return frames.slice(a, b + 1);
}

/**
 * Hats and snares can pull the tracker onto the off-beat. Kicks sit on the beat, so if the
 * low-frequency onsets are clearly stronger half a beat later, shift the whole grid.
 */
export function alignToKicks(frames: number[], lowOnset: Float64Array, period: number): number[] {
  if (frames.length < 8) return frames;
  const peakNear = (f: number) => {
    let m = 0;
    for (let k = -2; k <= 2; k++) m = Math.max(m, lowOnset[f + k] ?? 0);
    return m;
  };
  const shift = Math.round(period / 2);
  let on = 0;
  let off = 0;
  for (let i = 0; i < frames.length - 1; i++) {
    on += peakNear(frames[i]);
    off += peakNear(Math.round((frames[i] + frames[i + 1]) / 2));
  }
  if (off <= on * 1.3) return frames;
  const out = frames.map((f, i) => Math.round(i + 1 < frames.length ? (f + frames[i + 1]) / 2 : f + (i > 0 ? (f - frames[i - 1]) / 2 : shift)));
  return out.filter((f) => f < lowOnset.length);
}

// ---------- full analysis ----------

export function analyzeSamples(samples: Float32Array, sr = ANALYSIS_RATE): MusicAnalysis {
  const durationSec = samples.length / sr;
  const feat = computeFeatures(samples, sr);
  const tempo = estimateTempo(feat.onset, feat.frameRate);
  const beatFrames = alignToKicks(trackBeats(feat.onset, tempo.period), feat.lowOnset, tempo.period);
  const toSec = (f: number) => (f * HOP) / sr;
  const beats = beatFrames.map(toSec);

  // Bar phase: in 4/4 the kick usually lands on beat 1 of the bar.
  let phase = 0;
  let bestPhase = -Infinity;
  for (let p = 0; p < 4; p++) {
    let s = 0;
    let c = 0;
    for (let i = p; i < beatFrames.length; i += 4) {
      const f = beatFrames[i];
      s += feat.lowOnset[f] + 0.25 * feat.onset[f];
      c++;
    }
    const m = c ? s / c : 0;
    if (m > bestPhase) {
      bestPhase = m;
      phase = p;
    }
  }
  const downbeats = beats.filter((_, i) => i % 4 === phase);

  // Energy per beat: RMS plus bass, normalised.
  const frameEnergy = new Float64Array(feat.rms.length);
  let maxRms = 1e-9;
  let maxLow = 1e-9;
  for (let i = 0; i < feat.rms.length; i++) {
    maxRms = Math.max(maxRms, feat.rms[i]);
    maxLow = Math.max(maxLow, feat.low[i]);
  }
  for (let i = 0; i < feat.rms.length; i++) frameEnergy[i] = 0.5 * (feat.rms[i] / maxRms) + 0.5 * (feat.low[i] / maxLow);
  const beatEnergy = beatFrames.map((f, i) => {
    const end = i + 1 < beatFrames.length ? beatFrames[i + 1] : Math.min(frameEnergy.length, f + Math.round(tempo.period));
    let s = 0;
    for (let k = f; k < end; k++) s += frameEnergy[k];
    return end > f ? s / (end - f) : frameEnergy[f] ?? 0;
  });
  const maxBE = Math.max(1e-9, ...beatEnergy);
  const beatEnergyN = beatEnergy.map((e) => round3(e / maxBE));

  const drops = findDrops(beats, phase, beatEnergyN);

  let rmsSum = 0;
  for (const v of feat.rms) rmsSum += v;
  const meanRms = rmsSum / Math.max(1, feat.rms.length);
  let onsetRate = 0;
  for (const v of feat.onset) if (v > 1.5) onsetRate++;
  onsetRate /= Math.max(1, durationSec);
  const energy = Math.max(0, Math.min(1, 0.6 * Math.min(1, meanRms / 0.2) + 0.4 * Math.min(1, onsetRate / 12)));

  // Regularity of the beat grid.
  const iv = beats.slice(1).map((b, i) => b - beats[i]);
  const mIv = iv.reduce((s, v) => s + v, 0) / Math.max(1, iv.length);
  const sdIv = Math.sqrt(iv.reduce((s, v) => s + (v - mIv) ** 2, 0) / Math.max(1, iv.length));
  const regularity = mIv > 0 ? Math.max(0, 1 - sdIv / mIv / 0.15) : 0;

  return {
    version: 1,
    durationSec: round3(durationSec),
    bpm: Math.round(tempo.bpm * 10) / 10,
    beats: beats.map(round3),
    downbeats: downbeats.map(round3),
    beatEnergy: beatEnergyN,
    drops: drops.map(round3),
    energy: round3(energy),
    confidence: round3(0.5 * tempo.confidence + 0.5 * regularity),
    peaks: waveformPeaks(samples, 800),
  };
}

/** Drops: bar starts where the next 4 bars are much louder (and bassier) than the 4 before. */
export function findDrops(beats: number[], phase: number, energy: number[]): number[] {
  const cands: Array<{ t: number; i: number; s: number }> = [];
  const avg = (a: number, b: number) => {
    let s = 0;
    let c = 0;
    for (let i = Math.max(0, a); i < Math.min(energy.length, b); i++) {
      s += energy[i];
      c++;
    }
    return c ? s / c : 0;
  };
  for (let i = phase; i < beats.length; i += 4) {
    if (i < 8) continue;
    const before = avg(i - 16, i);
    const after = avg(i, i + 16);
    if (after < 0.55) continue;
    const s = (after - before) * after;
    if (s > 0.06) cands.push({ t: beats[i], i, s });
  }
  cands.sort((a, b) => b.s - a.s);
  const kept: typeof cands = [];
  for (const c of cands) {
    if (kept.every((k) => Math.abs(k.i - c.i) >= 32)) kept.push(c);
    if (kept.length >= 3) break;
  }
  return kept.map((k) => k.t);
}

export function waveformPeaks(samples: Float32Array, buckets: number): number[] {
  const out: number[] = [];
  const size = Math.max(1, Math.floor(samples.length / buckets));
  let max = 1e-9;
  for (let b = 0; b < buckets; b++) {
    let m = 0;
    const end = Math.min(samples.length, (b + 1) * size);
    for (let i = b * size; i < end; i++) {
      const v = Math.abs(samples[i]);
      if (v > m) m = v;
    }
    out.push(m);
    if (m > max) max = m;
  }
  return out.map((v) => Math.round((v / max) * 100) / 100);
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
