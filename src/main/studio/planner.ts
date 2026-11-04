// The auto-editor. Turns clips (with kill moments) + a music beat grid + a style into a frame-exact timeline.
//
// Each clip becomes: run-up -> [slow-in | KILL | slow-out] -> gap -> [slow-in | KILL | slow-out] ... -> tail.
// Speeds of the run-up, gaps and tail flex inside the style's speed range so every kill lands on a beat,
// and every cut lands on a beat. The music start is searched so the drop hits the reel's big moment:
// the hero clip's first kill, or the cut out of the intro card when there is one.
// Pure functions, no I/O, so it's fully testable.

import type { CaptionLine, IntroCard, MusicAnalysis, ReelClip, StyleRecipe, Timeline, TimelineClip, TimelineSegment, SegmentKind } from '../../shared/studio';

export interface PlanInput {
  clips: ReelClip[];
  style: StyleRecipe;
  fps: number;
  analysis?: MusicAnalysis | null;
  musicStart?: number | 'auto';
  heroUid?: string;
  intro?: IntroCard | null;
  captions?: CaptionLine[];
  maxSeconds?: number;
}

interface Piece {
  kind: SegmentKind;
  clip: number;
  src0: number;
  src1: number;
  out0: number;
  out1: number;
}

interface Grid {
  t: number[];
  strength: number[];
  downbeat: boolean[];
}

interface ClipLayout {
  pieces: Piece[];
  end: number;
  kills: number[];
  onBeat: boolean[];
  score: number;
}

const EPS = 1e-6;

// ---------- beat grid ----------

function makeGrid(an: MusicAnalysis, M: number): Grid {
  const down = new Set(an.downbeats.map((d) => Math.round(d * 1000)));
  const drop = an.drops[0];
  const downList = an.downbeats;
  const dropBar = drop !== undefined ? downList.findIndex((d) => Math.abs(d - drop) < 0.005) : -1;
  const t: number[] = [];
  const strength: number[] = [];
  const downbeat: boolean[] = [];
  for (const b of an.beats) {
    const o = b - M;
    if (o < -EPS) continue;
    const isDown = down.has(Math.round(b * 1000));
    let s = 1;
    if (isDown) {
      s = 2;
      const bar = downList.findIndex((d) => Math.abs(d - b) < 0.005);
      const rel = dropBar >= 0 ? bar - dropBar : bar;
      if (((rel % 4) + 4) % 4 === 0) s = 3;
    }
    if (drop !== undefined && Math.abs(b - drop) < 0.005) s = 6;
    else if (an.drops.slice(1).some((d) => Math.abs(b - d) < 0.005)) s = 4;
    t.push(Math.max(0, o));
    strength.push(s);
    downbeat.push(isDown);
  }
  return { t, strength, downbeat };
}

function beatsIn(g: Grid, lo: number, hi: number): number[] {
  // Binary search for the first beat >= lo.
  let a = 0;
  let b = g.t.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (g.t[m] < lo - EPS) a = m + 1;
    else b = m;
  }
  const out: number[] = [];
  for (let i = a; i < g.t.length && g.t[i] <= hi + EPS; i++) out.push(i);
  return out;
}

// ---------- clip layout ----------

interface Ctx {
  style: StyleRecipe;
  grid: Grid | null;
  /** Output time of the drop when it should land on this clip's first kill. */
  dropOut: number | null;
  /** Slow-mo applies to this clip. */
  slow: boolean;
}

export function cleanHits(c: ReelClip): number[] {
  const hits = [...c.hits].filter((h) => Number.isFinite(h) && h > c.in + 0.05 && h < c.out - 0.02).sort((a, b) => a - b);
  const out: number[] = [];
  for (const h of hits) if (!out.length || h - out[out.length - 1] >= 0.15) out.push(h);
  return out;
}

function layoutPlain(c: ReelClip, idx: number, T: number, ctx: Ctx): ClipLayout {
  const L = Math.max(0.1, c.out - c.in);
  let C = T + L;
  let score = 0;
  if (ctx.grid) {
    let best = -Infinity;
    for (const i of beatsIn(ctx.grid, T + Math.min(L, 1), T + L)) {
      const used = ctx.grid.t[i] - T;
      const sc = ctx.grid.strength[i] - (0.6 * (L - used)) / L;
      if (sc > best) {
        best = sc;
        C = ctx.grid.t[i];
      }
    }
    if (best > -Infinity) score = best;
  }
  const used = C - T;
  return { pieces: [{ kind: 'plain', clip: idx, src0: c.out - used, src1: c.out, out0: T, out1: C }], end: C, kills: [], onBeat: [], score };
}

function layoutClip(c: ReelClip, idx: number, T: number, ctx: Ctx): ClipLayout {
  const hits = cleanHits(c);
  if (!hits.length) return layoutPlain(c, idx, T, ctx);
  const st = ctx.style;
  const g = ctx.grid;
  const slow = st.slowmo.on && ctx.slow;
  const sp = slow ? st.slowmo.speed : 1;
  const [vmin, vmax] = st.speedRange;
  const cruise = st.cruiseSpeed;
  const n = hits.length;

  // How much source gets slowed around each kill.
  const pre = hits.map(() => (slow ? st.slowmo.before : 0));
  const post = hits.map(() => (slow ? st.slowmo.after : 0));
  pre[0] = Math.min(pre[0], Math.max(0, hits[0] - c.in - 0.1));
  post[n - 1] = Math.min(post[n - 1], Math.max(0, c.out - hits[n - 1]));
  for (let i = 0; i < n - 1; i++) {
    const gap = hits[i + 1] - hits[i];
    const want = post[i] + pre[i + 1];
    if (want > gap * 0.8) {
      const k = (gap * 0.8) / want;
      post[i] *= k;
      pre[i + 1] *= k;
    }
  }

  let score = 0;
  const kills: number[] = [];
  const onBeat: boolean[] = [];
  const pieces: Piece[] = [];
  const speedPenalty = (v: number, pref: number) => 2 * Math.abs(Math.log(v / pref));

  // --- run-up to the first kill ---
  const avail = hits[0] - pre[0] - c.in;
  const [leadMin, leadMax] = st.leadIn;
  const leadPref = leadMin + 0.35 * (leadMax - leadMin);
  const slowIn0 = pre[0] / sp;
  const tryLead = (K: number): { v: number; ok: boolean } => {
    const normalOut = K - T - slowIn0;
    if (normalOut < 0.05) return { v: cruise, ok: false };
    let v = cruise;
    if (normalOut * v > avail) v = avail / normalOut;
    return { v, ok: v >= vmin - EPS };
  };
  let K0 = NaN;
  let v0 = cruise;
  let beat0 = false;
  if (g) {
    let best = -Infinity;
    for (const i of beatsIn(g, T + leadMin, T + leadMax)) {
      const K = g.t[i];
      const r = tryLead(K);
      if (!r.ok) continue;
      let sc = g.strength[i] - speedPenalty(r.v, cruise) - (0.8 * Math.abs(K - T - leadPref)) / (leadMax - leadMin + 0.1);
      if (ctx.dropOut !== null && Math.abs(K - ctx.dropOut) < 0.005) sc += 25;
      if (sc > best) {
        best = sc;
        K0 = K;
        v0 = r.v;
      }
    }
    if (best > -Infinity) {
      score += best;
      beat0 = true;
    }
  }
  if (!Number.isFinite(K0)) {
    const normalOut = Math.max(0.05, Math.min(leadMax - slowIn0, avail / cruise));
    v0 = Math.min(cruise, avail / normalOut);
    K0 = T + normalOut + slowIn0;
    score -= 3;
  }
  const leadSrc1 = hits[0] - pre[0];
  const leadSrc0 = leadSrc1 - (K0 - T - slowIn0) * v0;
  pieces.push({ kind: 'lead', clip: idx, src0: leadSrc0, src1: leadSrc1, out0: T, out1: K0 - slowIn0 });
  pieces.push({ kind: 'slow-in', clip: idx, src0: leadSrc1, src1: hits[0], out0: K0 - slowIn0, out1: K0 });
  kills.push(K0);
  onBeat.push(beat0);

  // --- kill to kill ---
  for (let i = 0; i < n - 1; i++) {
    const K = kills[i];
    const gap = hits[i + 1] - hits[i];
    const s = post[i] + pre[i + 1];
    const m = gap - s;
    let D = NaN;
    let vs = sp;
    let vg = cruise;
    let hit = false;
    if (m < 0.03) {
      // Kills so close the slow-mo pieces touch: flex the slow-mo speed instead.
      const lo = Math.max(0.15, sp * 0.6);
      const hi = Math.min(1, Math.max(sp * 2, sp));
      if (g) {
        let best = -Infinity;
        for (const j of beatsIn(g, K + gap / hi, K + gap / lo)) {
          if (g.t[j] <= K + EPS) continue;
          const sc = g.strength[j] - speedPenalty(gap / (g.t[j] - K), sp);
          if (sc > best) {
            best = sc;
            D = g.t[j] - K;
          }
        }
        if (best > -Infinity) {
          score += best;
          hit = true;
        }
      }
      if (!Number.isFinite(D)) D = gap / sp;
      vs = gap / D;
      vg = vs;
    } else {
      const slowOut = s / sp;
      if (g) {
        let best = -Infinity;
        for (const j of beatsIn(g, K + slowOut + m / vmax, K + slowOut + m / vmin)) {
          const d = g.t[j] - K;
          if (d - slowOut < 0.04) continue;
          const v = m / (d - slowOut);
          let sc = g.strength[j] - speedPenalty(v, cruise);
          if (ctx.dropOut !== null && Math.abs(g.t[j] - ctx.dropOut) < 0.005) sc += 4;
          if (sc > best) {
            best = sc;
            D = d;
            vg = v;
          }
        }
        if (best > -Infinity) {
          score += best;
          hit = true;
        }
      }
      if (!Number.isFinite(D)) {
        vg = cruise;
        D = slowOut + m / cruise;
        score -= 2;
      }
    }
    const a = hits[i];
    const b = hits[i + 1];
    const o1 = K + post[i] / vs;
    pieces.push({ kind: 'slow-out', clip: idx, src0: a, src1: a + post[i], out0: K, out1: o1 });
    const gapLen = b - pre[i + 1] - (a + post[i]);
    const o2 = o1 + (gapLen > 1e-4 ? gapLen / vg : 0);
    if (gapLen > 1e-4) pieces.push({ kind: 'gap', clip: idx, src0: a + post[i], src1: b - pre[i + 1], out0: o1, out1: o2 });
    pieces.push({ kind: 'slow-in', clip: idx, src0: b - pre[i + 1], src1: b, out0: o2, out1: K + D });
    kills.push(K + D);
    onBeat.push(hit);
  }

  // --- after the last kill ---
  const Kl = kills[n - 1];
  const hl = hits[n - 1];
  const slowOutL = post[n - 1] / sp;
  pieces.push({ kind: 'slow-out', clip: idx, src0: hl, src1: hl + post[n - 1], out0: Kl, out1: Kl + slowOutL });
  const R = Math.max(0, c.out - hl - post[n - 1]);
  const [tailMin, tailMax] = st.tail;
  let C = NaN;
  let vt = cruise;
  if (g) {
    let best = -Infinity;
    for (const j of beatsIn(g, Kl + slowOutL + Math.min(tailMin, R / vmin), Kl + slowOutL + tailMax)) {
      const tailOut = g.t[j] - Kl - slowOutL;
      if (tailOut < 0.02) continue;
      let v = cruise;
      if (tailOut * v > R) v = R / tailOut;
      if (v < vmin - EPS) continue;
      const sc = g.strength[j] + (g.downbeat[j] ? 0.5 : 0) - speedPenalty(v, cruise);
      if (sc > best) {
        best = sc;
        C = g.t[j];
        vt = v;
      }
    }
    if (best > -Infinity) score += best;
  }
  if (!Number.isFinite(C)) {
    const tailOut = Math.max(0.02, Math.min(tailMax, R / cruise));
    vt = Math.min(cruise, R / tailOut) || cruise;
    C = Kl + slowOutL + tailOut;
    if (g) score -= 2;
  }
  const tailSrc0 = hl + post[n - 1];
  pieces.push({ kind: 'tail', clip: idx, src0: tailSrc0, src1: tailSrc0 + (C - Kl - slowOutL) * vt, out0: Kl + slowOutL, out1: C });
  return { pieces, end: C, kills, onBeat, score };
}

// ---------- whole reel ----------

interface Layout {
  pieces: Piece[];
  clips: Array<{ index: number; out: [number, number]; kills: number[]; onBeat: boolean[] }>;
  introEnd: number;
  end: number;
  score: number;
}

function layoutAll(input: PlanInput, grid: Grid | null, dropOut: number | null, heroIdx: number): Layout {
  const { clips, style } = input;
  const ctxBase = { style, grid };
  let T = 0;
  let score = 0;
  const pieces: Piece[] = [];
  let introEnd = 0;
  const dropOnIntro = !!input.intro;
  if (input.intro) {
    const want = Math.max(0.5, input.intro.seconds);
    T = want;
    if (grid) {
      let best = -Infinity;
      for (const i of beatsIn(grid, want * 0.6, want * 1.5)) {
        let sc = grid.strength[i] - Math.abs(grid.t[i] - want);
        if (dropOut !== null && Math.abs(grid.t[i] - dropOut) < 0.005) sc += 25;
        if (sc > best) {
          best = sc;
          T = grid.t[i];
        }
      }
      if (best > -Infinity) score += best;
    }
    introEnd = T;
    pieces.push({ kind: 'intro', clip: -1, src0: 0, src1: T, out0: 0, out1: T });
  }
  const out: Layout['clips'] = [];
  clips.forEach((c, i) => {
    const ctx: Ctx = { ...ctxBase, dropOut: !dropOnIntro && i === heroIdx ? dropOut : null, slow: style.slowmo.scope === 'all' || i === heroIdx };
    const l = layoutClip(c, i, T, ctx);
    pieces.push(...l.pieces);
    out.push({ index: i, out: [T, l.end], kills: l.kills, onBeat: l.onBeat });
    score += l.score;
    T = l.end;
  });
  return { pieces, clips: out, introEnd, end: T, score };
}

export function plan(input: PlanInput): Timeline {
  const { style, fps } = input;
  const an = input.analysis && input.analysis.beats.length >= 8 ? input.analysis : null;
  const sync = !!an && style.beatSync;
  const warnings: string[] = [];
  let heroIdx = input.clips.findIndex((c) => c.uid === input.heroUid);
  if (heroIdx < 0) heroIdx = input.clips.reduce((best, c, i, arr) => (c.score > arr[best].score ? i : best), 0);

  let M = typeof input.musicStart === 'number' ? Math.max(0, input.musicStart) : 0;
  let layout: Layout;
  if (sync && an) {
    const drop = an.drops[0];
    const candidates = typeof input.musicStart === 'number' ? [M] : [0, ...an.beats.filter((b) => b < an.durationSec - 4)];
    const downs = new Set(an.downbeats.map((d) => Math.round(d * 1000)));
    let best: Layout | undefined;
    let bestScore = -Infinity;
    let bestM = M;
    for (const m of candidates) {
      const grid = makeGrid(an, m);
      const dropOut = drop !== undefined && drop - m >= 0 ? drop - m : null;
      const l = layoutAll(input, grid, dropOut, heroIdx);
      let sc = l.score;
      if (downs.has(Math.round(m * 1000))) sc += 1.5;
      const remaining = an.durationSec - m;
      if (l.end > remaining) sc -= 40 + 5 * (l.end - remaining);
      if (dropOut !== null && input.clips.length) {
        const target = input.intro ? l.introEnd : l.clips[heroIdx]?.kills[0] ?? l.clips[heroIdx]?.out[0];
        if (target !== undefined && Math.abs(target - dropOut) < 0.02) sc += 30;
      } else if (drop !== undefined) sc -= 15;
      if (sc > bestScore) {
        bestScore = sc;
        best = l;
        bestM = m;
      }
    }
    layout = best!;
    M = bestM;
  } else {
    layout = layoutAll(input, null, null, heroIdx);
  }

  // ---------- snap to frames ----------
  const q = (t: number) => Math.round(t * fps) / fps;
  const segments: TimelineSegment[] = [];
  for (const p of layout.pieces) {
    const o0 = q(p.out0);
    const o1 = q(p.out1);
    if (o1 - o0 < 0.5 / fps) continue;
    const speed = p.kind === 'intro' ? 1 : (p.src1 - p.src0) / (o1 - o0);
    if (p.kind !== 'intro' && p.src1 - p.src0 < 1e-4) continue;
    segments.push({
      clipUid: p.clip >= 0 ? input.clips[p.clip].uid : 'intro',
      clipIndex: p.clip,
      kind: p.kind,
      src: [round4(p.src0), round4(p.src1)],
      out: [o0, o1],
      speed: round4(speed),
    });
  }
  // Close any gaps the frame snapping left by stretching the earlier segment.
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1];
    const cur = segments[i];
    if (Math.abs(cur.out[0] - prev.out[1]) > 1e-6) {
      prev.out[1] = cur.out[0];
      if (prev.kind !== 'intro') prev.speed = round4((prev.src[1] - prev.src[0]) / (prev.out[1] - prev.out[0]));
    }
  }
  const duration = segments.length ? segments[segments.length - 1].out[1] : 0;

  const tClips: TimelineClip[] = layout.clips.map((c) => ({
    uid: input.clips[c.index].uid,
    index: c.index,
    out: [q(c.out[0]), q(c.out[1])],
    kills: c.kills.map(q),
    onBeat: c.onBeat,
  }));
  const kills = tClips.flatMap((c) => c.kills);
  const cuts = tClips.slice(0, -1).map((c) => c.out[1]);
  if (layout.introEnd > 0 && tClips.length) cuts.unshift(q(layout.introEnd));

  let beats: number[] = [];
  let downbeats: number[] = [];
  let drop: number | undefined;
  let musicShort = false;
  if (an) {
    beats = an.beats.map((b) => round4(b - M)).filter((b) => b >= 0 && b <= duration);
    downbeats = an.downbeats.map((b) => round4(b - M)).filter((b) => b >= 0 && b <= duration);
    const d = an.drops[0];
    if (d !== undefined && d - M >= 0 && d - M <= duration) drop = round4(d - M);
    musicShort = an.durationSec - M < duration - 0.05;
    if (sync && d !== undefined && tClips.length) {
      const hero = tClips.find((c) => c.index === heroIdx);
      const target = layout.introEnd > 0 ? q(layout.introEnd) : hero ? hero.kills[0] ?? hero.out[0] : undefined;
      if (target !== undefined && (drop === undefined || Math.abs(target - drop) > 1.5 / fps)) {
        const what = layout.introEnd > 0 ? 'The cut out of the hook card' : `Clip ${heroIdx + 1}, your big moment,`;
        warnings.push(
          target > d
            ? `${what} can't land on the drop: the drop is only ${d.toFixed(1)} s into the song, and that moment comes ${target.toFixed(1)} s into the reel. Move it earlier, or use a song with a later drop.`
            : `${what} couldn't be lined up with the song's drop.`,
        );
      }
    }
    if (musicShort) warnings.push(`The song ends ${(duration - (an.durationSec - M)).toFixed(1)} s before the reel does. Pick a longer song, start it earlier, or drop a clip.`);
  }
  const offBeat = tClips.reduce((s, c) => s + c.onBeat.filter((b) => !b).length, 0);
  if (sync && offBeat) warnings.push(`${offBeat} kill${offBeat === 1 ? '' : 's'} couldn't land on a beat within the style's speed range.`);
  if (!input.clips.length) warnings.push('Add some clips to start.');
  const noHits = input.clips.filter((c) => !cleanHits(c).length).length;
  if (noHits) warnings.push(`${noHits} clip${noHits === 1 ? ' has' : 's have'} no kill marked, so ${noHits === 1 ? 'it' : 'they'} just get trimmed to the beat.`);
  if (input.maxSeconds && duration > input.maxSeconds) warnings.push(`The reel is ${duration.toFixed(0)} s, longer than this platform allows (${input.maxSeconds} s).`);

  return {
    fps,
    duration,
    segments,
    clips: tClips,
    kills,
    cuts,
    beats,
    downbeats,
    drop,
    introEnd: q(layout.introEnd),
    captions: placeCaptions(input.captions ?? [], beats, duration, style.captions.beatsPerLine),
    musicStart: round4(M),
    musicShort,
    warnings,
  };
}

/** Lines with times keep them. The rest are laid end to end on the beat grid (or every 2 s without music). */
export function placeCaptions(lines: CaptionLine[], beats: number[], duration: number, beatsPerLine: number) {
  const out: Array<{ text: string; start: number; end: number }> = [];
  let cursor = beats.length ? 0 : 0.3;
  let beatIdx = 0;
  for (const l of lines) {
    const text = (l.text ?? '').trim();
    if (!text) continue;
    if (typeof l.start === 'number' && typeof l.end === 'number' && l.end > l.start) {
      out.push({ text, start: round4(l.start), end: round4(Math.min(duration, l.end)) });
      continue;
    }
    let start: number;
    let end: number;
    if (beats.length) {
      start = beats[beatIdx] ?? cursor;
      const endIdx = beatIdx + beatsPerLine;
      end = beats[endIdx] ?? Math.min(duration, start + 2);
      beatIdx = endIdx;
    } else {
      start = cursor;
      end = cursor + 2;
    }
    cursor = end;
    if (start >= duration - 0.2) break;
    out.push({ text, start: round4(start), end: round4(Math.min(duration, end)) });
  }
  return out;
}

/** Weakest first, so the best play lands last (and on the drop). */
export function orderClips(clips: ReelClip[], order: 'manual' | 'build-up'): ReelClip[] {
  if (order === 'manual') return clips;
  return [...clips].sort((a, b) => a.score - b.score);
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;
