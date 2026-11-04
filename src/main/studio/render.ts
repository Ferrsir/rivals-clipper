// Turns a planned timeline into ffmpeg jobs.
//
// Stage A, once per clip: cut the clip's segments out of the source in one decode, crop to the
// output shape, apply per-segment speed (with frame blending for slow-mo and motion blur for
// speed-ups) and write a lossless-ish intermediate with game and mic audio on separate tracks.
// Intermediates are cached by content hash, so changing effects or music doesn't redo this.
//
// Stage B, once per export: join the intermediates, then add everything keyed to output time
// (zoom punches, shake, flashes, colour split, afterimage trails, grade, captions, fade) and mix
// game + mic + music (+ impact sounds), ducking the music while you talk, loudness-normalised.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { OutroText, ExportFormat, IntroCard, Mix, ReelClip, StyleRecipe, Timeline, TimelineSegment } from '../../shared/studio';

export interface Size {
  width: number;
  height: number;
}

export interface FfJob {
  /** Arguments after the ffmpeg binary. */
  args: string[];
  /** Filter graph, written to a file and passed with -filter_complex_script. */
  filter: string;
  output: string;
  /** Expected output duration, for progress. */
  duration: number;
}

export interface EncoderChoice {
  name: 'libx264' | 'h264_nvenc' | 'h264_amf' | 'h264_qsv';
}

const r3 = (v: number) => (Math.round(v * 1000) / 1000).toString();
const r6 = (v: number) => (Math.round(v * 1e6) / 1e6).toString();

/** Join segments that run at the same speed (fewer filter branches, same result). */
export function mergeSegments(segs: TimelineSegment[]): TimelineSegment[] {
  const out: TimelineSegment[] = [];
  for (const s of segs) {
    const p = out[out.length - 1];
    if (p && p.clipUid === s.clipUid && Math.abs(p.speed - s.speed) < 0.01 && Math.abs(p.src[1] - s.src[0]) < 1e-4 && Math.abs(p.out[1] - s.out[0]) < 1e-6) {
      p.src = [p.src[0], s.src[1]];
      p.out = [p.out[0], s.out[1]];
      p.speed = (p.src[1] - p.src[0]) / (p.out[1] - p.out[0]);
      if (s.kind !== p.kind) p.kind = p.kind === 'slow-in' || s.kind === 'slow-out' ? 'slow-in' : p.kind;
    } else out.push({ ...s, src: [...s.src] as [number, number], out: [...s.out] as [number, number] });
  }
  return out;
}

/** atempo only accepts 0.5..100 per instance, so chain it for big slow-downs. */
export function atempoChain(speed: number): string {
  const parts: string[] = [];
  let s = speed;
  while (s < 0.5) {
    parts.push('atempo=0.5');
    s /= 0.5;
  }
  while (s > 2) {
    parts.push('atempo=2');
    s /= 2;
  }
  if (Math.abs(s - 1) > 1e-4) parts.push(`atempo=${r6(s)}`);
  return parts.join(',');
}

/** Crop the source to the output's shape around the clip's crop centre. */
export function cropFilter(clip: Pick<ReelClip, 'cropX' | 'cropY' | 'cropZoom'>, out: Size): string {
  const ar = out.width / out.height;
  const z = Math.max(1, clip.cropZoom || 1);
  const cx = Math.min(1, Math.max(0, clip.cropX ?? 0.5));
  const cy = Math.min(1, Math.max(0, clip.cropY ?? 0.5));
  // Width limited by the source width for wide outputs on narrower sources.
  const w = `trunc(min(iw\\,ih*${r6(ar)})/${r6(z)}/2)*2`;
  const h = `trunc(min(ih\\,iw/${r6(ar)})/${r6(z)}/2)*2`;
  return `crop=w=${w}:h=${h}:x=(iw-ow)*${r6(cx)}:y=(ih-oh)*${r6(cy)}`;
}

export function hashOf(v: unknown): string {
  return crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 16);
}

interface ClipJobOpts {
  clip: ReelClip;
  segments: TimelineSegment[];
  size: Size;
  fps: number;
  style: StyleRecipe;
  preview: boolean;
  /** Clip uid is the hero (for slow-mo gain etc. nothing changes yet, kept for cache key clarity). */
  workDir: string;
}

/** Stage A for one clip. */
export function buildClipJob(o: ClipJobOpts): FfJob {
  const segs = mergeSegments(o.segments);
  const { clip, size, fps, style } = o;
  const key = hashOf({ v: 3, f: clip.videoFile, segs: segs.map((s) => [s.src, s.out, s.speed]), size, fps, crop: [clip.cropX, clip.cropY, clip.cropZoom], mic: clip.useMic && clip.hasMic, mute: !!clip.muteGame, preview: o.preview, sm: [style.slowmo.smooth, style.slowmo.gameVolume, style.motionBlur, style.slowmo.speed] });
  const output = path.join(o.workDir, `clip-${key}.mkv`);
  const s0 = Math.max(0, Math.min(...segs.map((s) => s.src[0])) - 0.05);
  const s1 = Math.max(...segs.map((s) => s.src[1]));
  const n = segs.length;
  const scaleFlags = o.preview ? 'fast_bilinear' : 'bicubic';
  const lines: string[] = [];
  lines.push(`[0:v]setpts=PTS-STARTPTS,${cropFilter(clip, size)},scale=${size.width}:${size.height}:flags=${scaleFlags},setsar=1,format=yuv420p,split=${n}${segs.map((_, i) => `[vi${i}]`).join('')}`);
  const useMic = clip.useMic && clip.hasMic;
  const audioIn = (idx: number, label: string) =>
    `[0:a:${idx}]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=${n}${segs.map((_, i) => `[${label}${i}]`).join('')}`;
  lines.push(audioIn(0, 'gi'));
  if (useMic) lines.push(audioIn(1, 'mi'));

  const slowSpeedMax = 0.8;
  segs.forEach((s, i) => {
    const a = s.src[0] - s0;
    const b = s.src[1] - s0;
    const outDur = s.out[1] - s.out[0];
    const frames = Math.max(1, Math.round(outDur * fps));
    const dur = frames / fps;
    const speed = s.speed;
    const v: string[] = [`trim=start=${r6(a)}:end=${r6(b)}`, 'setpts=PTS-STARTPTS'];
    if (style.motionBlur.on && speed >= style.motionBlur.minSpeed && !o.preview) {
      const k = Math.max(2, Math.min(5, Math.round(speed)));
      v.push(`tmix=frames=${k}`);
    }
    v.push(`setpts=PTS/${r6(speed)}`);
    if (speed < slowSpeedMax && !o.preview) {
      if (style.slowmo.smooth === 'motion') v.push(`minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`);
      else if (style.slowmo.smooth === 'blend') v.push(`framerate=fps=${fps}:interp_start=0:interp_end=255:scene=100`);
    }
    v.push(`fps=${fps}`, `tpad=stop_mode=clone:stop_duration=${r3(Math.max(0.2, 3 / fps))}`, `trim=end_frame=${frames}`, 'setpts=PTS-STARTPTS');
    lines.push(`[vi${i}]${v.join(',')}[v${i}]`);

    const slow = speed < slowSpeedMax;
    const gGain = clip.muteGame ? 0 : slow ? style.slowmo.gameVolume : 1;
    const aChain = (src: string, gain: number) => {
      const parts = [`atrim=start=${r6(a)}:end=${r6(b)}`, 'asetpts=PTS-STARTPTS'];
      const t = atempoChain(speed);
      if (t) parts.push(t);
      if (Math.abs(gain - 1) > 1e-3) parts.push(`volume=${r3(gain)}`);
      parts.push(`apad=whole_dur=${r6(dur)}`, `atrim=end=${r6(dur)}`, 'asetpts=PTS-STARTPTS');
      return `[${src}${i}]${parts.join(',')}`;
    };
    lines.push(`${aChain('gi', gGain)}[g${i}]`);
    if (useMic) lines.push(`${aChain('mi', slow ? 0.6 : 1)}[m${i}]`);
    else lines.push(`anullsrc=r=48000:cl=stereo,atrim=end=${r6(dur)},aformat=sample_fmts=fltp:channel_layouts=stereo[m${i}]`);
  });
  lines.push(`${segs.map((_, i) => `[v${i}][g${i}][m${i}]`).join('')}concat=n=${n}:v=1:a=2[v][ga][ma]`);

  const total = segs.reduce((s, x) => s + Math.max(1, Math.round((x.out[1] - x.out[0]) * fps)) / fps, 0);
  const args = [
    '-ss', r6(s0), '-t', r6(s1 - s0 + 0.3), '-i', clip.videoFile,
    '-map', '[v]', '-map', '[ga]', '-map', '[ma]',
    ...intermediateCodec(o.preview, fps),
    output,
  ];
  return { args, filter: lines.join(';\n'), output, duration: total };
}

function intermediateCodec(preview: boolean, fps: number): string[] {
  return ['-c:v', 'libx264', '-preset', preview ? 'ultrafast' : 'veryfast', '-crf', preview ? '23' : '12', '-g', String(fps), '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ar', '48000'];
}

/** Where the picture sits on a band-layout hook card, as fractions of the frame height. */
export function introBand(size: Size): { center: number; height: number } {
  return size.height >= size.width ? { center: 0.4, height: 0.4 } : { center: 0.4, height: 0.6 };
}

/**
 * Stage A for the intro card: a still image held for the intro's length.
 * band: the picture in a strip across the middle, over a blurred, darker copy of itself (the reference look).
 * full: the picture fills the frame (blurred when it's just the first frame of the first clip).
 */
export function buildIntroJob(o: { image: string; blurred: boolean; seconds: number; size: Size; fps: number; preview: boolean; workDir: string; layout?: 'band' | 'full' }): FfJob {
  const frames = Math.max(1, Math.round(o.seconds * o.fps));
  const dur = frames / o.fps;
  const layout = o.layout ?? 'band';
  const key = hashOf({ v: 2, img: o.image, mt: safeMtime(o.image), frames, size: o.size, fps: o.fps, blurred: o.blurred, preview: o.preview, layout });
  const output = path.join(o.workDir, `intro-${key}.mkv`);
  const { width: W, height: H } = o.size;
  const cover = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
  const tail = `format=yuv420p,fps=${o.fps},trim=end_frame=${frames},setpts=PTS-STARTPTS[v]`;
  let video: string;
  if (layout === 'band') {
    const band = introBand(o.size);
    const bw = Math.round((W * 0.96) / 2) * 2;
    const bh = Math.round((H * band.height) / 2) * 2;
    video = [
      `[0:v]split=2[bgsrc][fgsrc]`,
      `[bgsrc]${cover},boxblur=${Math.max(8, Math.round(W / 40))}:2,eq=brightness=-0.16:saturation=0.85[bg]`,
      `[fgsrc]scale=${bw}:${bh}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[fg]`,
      `[bg][fg]overlay=x=(W-w)/2:y=${Math.round(H * band.center)}-h/2,${tail}`,
    ].join(';\n');
  } else {
    const look = o.blurred ? ',boxblur=24:2,eq=brightness=-0.12:saturation=0.8' : '';
    video = `[0:v]${cover}${look},${tail}`;
  }
  const filter = [video, `anullsrc=r=48000:cl=stereo,atrim=end=${r6(dur)},aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=2[ga][ma]`].join(';\n');
  const args = ['-loop', '1', '-framerate', String(o.fps), '-t', r6(dur + 0.2), '-i', o.image, '-map', '[v]', '-map', '[ga]', '-map', '[ma]', ...intermediateCodec(o.preview, o.fps), output];
  return { args, filter, output, duration: dur };
}

function safeMtime(f: string): number {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return 0;
  }
}

// ---------- stage B: effects keyed to output time ----------

interface Pulse {
  t: number;
  amount: number;
  attack: number;
  release: number;
}

/** Sum of attack/decay envelopes, as an ffmpeg expression in variable `T`. */
export function envelopeExpr(pulses: Pulse[], T: string): string {
  if (!pulses.length) return '0';
  return pulses
    .map((p) => {
      const a = p.t - p.attack;
      const e = p.t + p.release * 4;
      return `between(${T},${r3(a)},${r3(e)})*${r3(p.amount)}*if(lt(${T},${r3(p.t)}),(${T}-${r3(a)})/${r6(Math.max(1e-3, p.attack))},exp((${r3(p.t)}-${T})/${r6(p.release)}))`;
    })
    .join('+');
}

/** Short decaying window (1 at t, 0 after duration), squared falloff. */
function decayExpr(times: number[], dur: number, T: string, amount = 1): string {
  if (!times.length) return '0';
  return times.map((t) => `between(${T},${r3(t)},${r3(t + dur)})*${r3(amount)}*pow(1-(${T}-${r3(t)})/${r6(dur)},2)`).join('+');
}

function windowsExpr(windows: Array<[number, number]>, T = 't'): string {
  return windows.map(([a, b]) => `between(${T},${r3(a)},${r3(b)})`).join('+') || '0';
}

export interface AssembleOpts {
  inputs: string[];
  timeline: Timeline;
  style: StyleRecipe;
  mix: Mix;
  format: ExportFormat;
  size: Size;
  fps: number;
  music: { file: string; start: number } | null;
  anyMic: boolean;
  preview: boolean;
  encoder: EncoderChoice;
  output: string;
  /** Also write the reel's audio without music, for a no-music copy. */
  noMusicAudio?: string;
  workDir: string;
  fontFile?: string;
  intro?: IntroCard | null;
  outro?: OutroText | null;
}

export function beatPulses(tl: Timeline, which: 'none' | 'downbeats' | 'all'): number[] {
  if (which === 'none') return [];
  const list = which === 'all' ? tl.beats : tl.downbeats;
  // Skip pulses that sit on a kill: the kill punch already covers them.
  return list.filter((b) => tl.kills.every((k) => Math.abs(k - b) > 0.08) && b >= tl.introEnd);
}

/** Video effects chain for stage B (exported for tests). */
export function effectsChain(o: Pick<AssembleOpts, 'timeline' | 'style' | 'size' | 'fps' | 'preview'>): string[] {
  const { timeline: tl, style: st, size, fps } = o;
  const T = `(in/${fps})`;
  const chain: string[] = [];

  // Afterimage trails over slow-mo (or over the whole reel).
  if (st.echo.on && !o.preview) {
    const wins = st.echo.onSlowmo
      ? tl.segments.filter((s) => s.speed < 0.8 && s.kind !== 'intro').map((s) => [s.out[0], s.out[1]] as [number, number])
      : [[tl.introEnd, tl.duration] as [number, number]];
    if (wins.length) {
      const k = 6;
      const w = Array.from({ length: k }, (_, i) => r3(Math.pow(1 - st.echo.strength * 0.85, i))).join(' ');
      chain.push(`tmix=frames=${k}:weights='${w}':enable='${windowsExpr(wins)}'`);
    }
  }

  // Zoom punches and shake through one per-frame perspective warp (sub-pixel smooth).
  const zoomPulses: Pulse[] = [];
  if (st.zoom.on) {
    for (const k of tl.kills) zoomPulses.push({ t: k, amount: st.zoom.amount - 1, attack: st.zoom.attack, release: st.zoom.release });
    for (const b of beatPulses(tl, st.zoom.onBeats)) zoomPulses.push({ t: b, amount: st.zoom.beatAmount - 1, attack: 0.02, release: 0.12 });
  }
  if (st.transition === 'whip') for (const c of tl.cuts) zoomPulses.push({ t: c, amount: 0.12, attack: 0.08, release: 0.1 });
  const shakeTimes: Array<{ t: number; amount: number; dur: number }> = [];
  if (st.shake.on) {
    for (const k of tl.kills) shakeTimes.push({ t: k, amount: st.shake.amount, dur: st.shake.duration });
    for (const b of beatPulses(tl, st.shake.onBeats)) shakeTimes.push({ t: b, amount: st.shake.beatAmount, dur: 0.15 });
  }
  if (st.transition === 'whip') for (const c of tl.cuts) shakeTimes.push({ t: c - 0.06, amount: 0.01, dur: 0.18 });
  if (zoomPulses.length || shakeTimes.length) {
    const shakeEnv = shakeTimes.length
      ? shakeTimes.map((s) => `between(${T},${r3(s.t)},${r3(s.t + s.dur)})*${r6(s.amount)}*pow(1-(${T}-${r3(s.t)})/${r6(s.dur)},2)`).join('+')
      : '0';
    const f = st.shake.frequency;
    // st(0)=zoom, st(1)=dx, st(2)=dy. Zoom grows with the shake so the frame edge never shows.
    const pre =
      `st(3,${shakeEnv});` +
      `st(0,1+${envelopeExpr(zoomPulses, T)}+2.2*ld(3));` +
      `st(1,ld(3)*W*(sin(${r3(2 * Math.PI * f)}*${T})+0.6*sin(${r3(2 * Math.PI * f * 1.73)}*${T}+1.3))/1.6);` +
      `st(2,ld(3)*H*0.6*(sin(${r3(2 * Math.PI * f * 1.31)}*${T}+2.1)+0.6*sin(${r3(2 * Math.PI * f * 2.07)}*${T}+0.4))/1.6);`;
    const xl = `${pre}W/2-W/(2*ld(0))+ld(1)`;
    const xr = `${pre}W/2+W/(2*ld(0))+ld(1)`;
    const yt = `${pre}H/2-H/(2*ld(0))+ld(2)`;
    const yb = `${pre}H/2+H/(2*ld(0))+ld(2)`;
    chain.push(`perspective=x0='${xl}':y0='${yt}':x1='${xr}':y1='${yt}':x2='${xl}':y2='${yb}':x3='${xr}':y3='${yb}':interpolation=${o.preview ? 'linear' : 'cubic'}:eval=frame`);
  }

  // Colour grade + flashes + dips, all in one eq.
  const flashTimes: number[] = [];
  if (st.flash.on) {
    if (st.flash.onKills) flashTimes.push(...tl.kills);
    if (st.flash.onDrop && tl.drop !== undefined) flashTimes.push(tl.drop);
    if (st.flash.onCuts) flashTimes.push(...tl.cuts);
  }
  if (st.transition === 'flash') for (const c of tl.cuts) if (!flashTimes.some((t) => Math.abs(t - c) < 0.05)) flashTimes.push(c);
  const flash = decayExpr([...new Set(flashTimes.map((t) => Math.round(t * 1000) / 1000))].sort((a, b) => a - b), st.flash.duration, 't', st.flash.on ? st.flash.strength : 0.45);
  const dips = st.transition === 'dip' ? tl.cuts.map((c) => `between(t,${r3(c - 0.18)},${r3(c + 0.18)})*(1-abs(t-${r3(c)})/0.18)`).join('+') || '0' : '0';
  const g = st.grade;
  const needEq = flash !== '0' || dips !== '0' || g.contrast !== 1 || g.saturation !== 1 || g.brightness !== 0 || g.gamma !== 1;
  if (needEq) {
    const bright = `${r3(g.brightness)}+(${flash})-0.85*(${dips})`;
    const sat = `${r3(g.saturation)}*(1-0.5*min(1,${flash}))*(1-0.8*min(1,${dips}))`;
    chain.push(`eq=contrast=${r3(g.contrast)}:brightness='${bright}':saturation='${sat}':gamma=${r3(g.gamma)}:eval=frame`);
  }

  // Colour split on kills (chroma shift works in YUV, so it's cheap).
  if (st.rgbSplit.on && tl.kills.length) {
    const px = Math.max(1, Math.round((st.rgbSplit.amount * size.width) / 1080 / 2));
    chain.push(`chromashift=cbh=${-px}:crh=${px}:cbv=${Math.round(px / 2)}:crv=${-Math.round(px / 2)}:enable='${windowsExpr(tl.kills.map((k) => [k - 0.02, k + st.rgbSplit.duration] as [number, number]))}'`);
  }
  if (g.vignette > 0) chain.push(`vignette=angle=${r3(0.15 + g.vignette * 0.75)}`);
  if (g.sharpen > 0 && !o.preview) chain.push(`unsharp=5:5:${r3(g.sharpen)}:5:5:0`);
  return chain;
}

/** Wrap a caption into lines that fit the safe width. */
export function wrapText(text: string, maxChars: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

/** When each hook line shows: the intro split evenly, each line on until the next starts. */
export function hookTimes(lines: number, introEnd: number): Array<[number, number]> {
  if (lines <= 0 || introEnd <= 0) return [];
  const step = introEnd / lines;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return Array.from({ length: lines }, (_, i) => [r(i * step), r(i === lines - 1 ? introEnd : (i + 1) * step)] as [number, number]);
}

/** drawtext filters for captions, the hook lines and the end text. Text goes through files, so nothing needs escaping. */
export function textFilters(o: Pick<AssembleOpts, 'timeline' | 'style' | 'format' | 'size' | 'workDir' | 'fontFile' | 'intro' | 'outro'>): string[] {
  if (!o.fontFile) return [];
  const { size, format, style } = o;
  const out: string[] = [];
  const font = path.basename(o.fontFile);
  const safeW = size.width * (1 - format.safe.left - format.safe.right);
  const fontSize = Math.round(style.captions.size * size.width);
  const maxChars = Math.max(8, Math.floor((safeW * 0.94) / (fontSize * 0.56)));
  const yFor = (pos: 'top' | 'middle' | 'bottom' | number, lines: number, fs2: number) => {
    const block = lines * fs2 * 1.18;
    if (typeof pos === 'number') return Math.round(pos);
    if (pos === 'top') return Math.round(size.height * (format.safe.top + 0.06));
    if (pos === 'middle') return Math.round((size.height - block) / 2);
    return Math.round(size.height * (1 - format.safe.bottom - 0.05) - block);
  };
  const xCenter = Math.round(size.width * format.safe.left + safeW / 2);
  let n = 0;
  const add = (text: string, start: number, end: number, pos: 'top' | 'middle' | 'bottom' | number, opts: { scale?: number; upper?: boolean; fade?: number } = {}) => {
    const scale = opts.scale ?? 1;
    const upper = opts.upper ?? style.captions.uppercase;
    const t = upper ? text.toUpperCase() : text;
    const fs2 = Math.round(fontSize * scale);
    // Capitals are wider than the average letter, so they wrap sooner.
    const lines = wrapText(t, Math.max(6, Math.floor((maxChars / scale) * (upper ? 0.8 : 1))));
    const file = `cap${n++}.txt`;
    fs.writeFileSync(path.join(o.workDir, file), lines.join('\n'), 'utf8');
    const y = yFor(pos, lines.length, fs2);
    const fade = opts.fade ?? 0.08;
    out.push(
      `drawtext=fontfile=${font}:textfile=${file}:expansion=none:text_align=C:fontsize=${fs2}:line_spacing=${Math.round(fs2 * 0.15)}:fontcolor=white:borderw=${Math.max(2, Math.round(fs2 * 0.09))}:bordercolor=black@0.9:shadowx=0:shadowy=${Math.round(fs2 * 0.06)}:shadowcolor=black@0.5:x=${xCenter}-text_w/2:y=${y}:alpha='min(1,(t-${r3(start)})/${fade})':enable='between(t,${r3(start)},${r3(end)})'`,
    );
  };
  if (o.intro?.text && o.timeline.introEnd > 0) {
    // Hook lines play one after another, fading in like the reference edits.
    const lines = o.intro.text.split('\n').map((l) => l.trim()).filter(Boolean);
    const band = (o.intro.layout ?? 'band') === 'band';
    const times = hookTimes(lines.length, o.timeline.introEnd);
    const b = introBand(size);
    const under = size.height * (b.center + b.height / 2) + size.height * 0.03;
    lines.forEach((line, i) => add(line, times[i][0], times[i][1], band ? under : 'middle', { scale: 1.2, upper: band ? true : undefined, fade: 0.25 }));
  }
  for (const c of o.timeline.captions) add(c.text, c.start, c.end, style.captions.position);
  if (o.outro?.text) {
    const start = Math.max(o.timeline.introEnd, o.timeline.duration - o.outro.seconds);
    add(o.outro.text, start, o.timeline.duration, 'top', { scale: 1.3, upper: true, fade: 0.3 });
  }
  return out;
}

/** One thump per kill: a fast pitch drop with an exponential decay. */
export function impactExpr(kills: number[]): string {
  if (!kills.length) return '0';
  return kills
    .map((k) => {
      const d = `(t-${r3(k)})`;
      return `between(t,${r3(k)},${r3(k + 0.6)})*sin(2*PI*(45*${d}+7.2*(1-exp(-25*${d}))))*exp(-7*${d})`;
    })
    .join('+');
}

export function videoEncoderArgs(enc: EncoderChoice, format: ExportFormat, fps: number, preview: boolean): string[] {
  if (preview) return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p'];
  const max = `${format.maxrateKbps}k`;
  const buf = `${format.maxrateKbps * 2}k`;
  const gop = ['-g', String(fps * 2)];
  switch (enc.name) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', String(format.crf + 2), '-b:v', '0', '-maxrate', max, '-bufsize', buf, '-profile:v', 'high', '-pix_fmt', 'yuv420p', ...gop];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'vbr_peak', '-b:v', `${Math.round(format.maxrateKbps * 0.7)}k`, '-maxrate', max, '-profile:v', 'high', '-pix_fmt', 'yuv420p', ...gop];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'slow', '-global_quality', String(format.crf + 3), '-maxrate', max, '-bufsize', buf, '-profile:v', 'high', '-pix_fmt', 'nv12', ...gop];
    default: {
      const level = format.width * format.height > 2073600 ? '5.1' : '4.2';
      return ['-c:v', 'libx264', '-preset', 'slow', '-crf', String(format.crf), '-maxrate', max, '-bufsize', buf, '-profile:v', 'high', '-level:v', level, '-pix_fmt', 'yuv420p', ...gop, '-bf', '2'];
    }
  }
}

/** Stage B: join intermediates, add effects, mix audio, encode. */
export function buildAssembleJob(o: AssembleOpts): FfJob & { concatList: string } {
  const tl = o.timeline;
  const dur = tl.duration;
  const concatList = path.join(o.workDir, `concat-${hashOf(o.inputs)}.txt`);
  const listBody = o.inputs.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n';
  fs.writeFileSync(concatList, listBody, 'utf8');

  const lines: string[] = [];
  const vchain = [...effectsChain(o), ...textFilters(o)];
  const fo = Math.min(o.style.fadeOut, dur / 3);
  if (fo > 0.01) vchain.push(`fade=t=out:st=${r3(dur - fo)}:d=${r3(fo)}`);
  vchain.push('format=yuv420p');
  lines.push(`[0:v]${vchain.join(',')}[vout]`);

  // ---- audio ----
  const mix = o.mix;
  lines.push(`[0:a:0]volume=${r3(mix.game)}[game]`);
  const micActive = o.anyMic && mix.mic > 0;
  const duck = micActive && mix.duck && !!o.music;
  if (micActive) lines.push(`[0:a:1]volume=${r3(mix.mic)}${duck ? ',asplit=2[mic][mickey]' : '[mic]'}`);
  const parts = ['[game]'];
  if (micActive) parts.push('[mic]');
  if (o.style.impactSound > 0 && tl.kills.length) {
    lines.push(`aevalsrc=exprs='${impactExpr(tl.kills)}':s=48000:d=${r3(dur)},aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${r3(o.style.impactSound * 0.9)}[imp]`);
    parts.push('[imp]');
  }
  const noMusicParts = [...parts];
  if (o.music) {
    const mfo = Math.max(0.3, fo);
    lines.push(`[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${r3(mix.music)},afade=t=in:d=0.02,afade=t=out:st=${r3(Math.max(0, dur - mfo))}:d=${r3(mfo)},apad,atrim=end=${r3(dur)}${duck ? '[mus]' : '[music]'}`);
    if (duck) lines.push('[mus][mickey]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=400:makeup=1[music]');
    parts.push('[music]');
  }
  const finishAudio = (inputs: string[], label: string) => {
    if (inputs.length === 1) return `${inputs[0]}loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,afade=t=out:st=${r3(Math.max(0, dur - Math.max(0.2, fo)))}:d=${r3(Math.max(0.2, fo))}[${label}]`;
    return `${inputs.join('')}amix=inputs=${inputs.length}:normalize=0:duration=first,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,afade=t=out:st=${r3(Math.max(0, dur - Math.max(0.2, fo)))}:d=${r3(Math.max(0.2, fo))}[${label}]`;
  };
  if (o.noMusicAudio && o.music) {
    // Split every source used by both mixes.
    const split = (lbl: string) => {
      const name = lbl.slice(1, -1);
      lines.push(`${lbl}asplit=2[${name}A][${name}B]`);
      return [`[${name}A]`, `[${name}B]`];
    };
    const a: string[] = [];
    const b: string[] = [];
    for (const p of noMusicParts) {
      const [x, y] = split(p);
      a.push(x);
      b.push(y);
    }
    lines.push(finishAudio([...a, '[music]'], 'aout'));
    lines.push(finishAudio(b, 'anomusic'));
  } else lines.push(finishAudio(parts, 'aout'));

  const args = [
    '-f', 'concat', '-safe', '0', '-i', concatList,
    ...(o.music ? ['-ss', r6(o.music.start), '-t', r6(dur + 1), '-i', o.music.file] : []),
    '-map', '[vout]', '-map', '[aout]',
    ...videoEncoderArgs(o.encoder, o.format, o.fps, o.preview),
    '-r', String(o.fps),
    '-c:a', 'aac', '-b:a', o.preview ? '128k' : `${o.format.audioKbps}k`, '-ar', '48000',
    '-t', r6(dur), '-movflags', '+faststart',
    o.output,
  ];
  if (o.noMusicAudio && o.music) args.push('-map', '[anomusic]', '-c:a', 'aac', '-b:a', `${o.format.audioKbps}k`, '-ar', '48000', '-t', r6(dur), o.noMusicAudio);
  return { args, filter: lines.join(';\n'), output: o.output, duration: dur, concatList };
}
