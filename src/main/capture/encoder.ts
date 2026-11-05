// Picks the GPU encoder for the local recorder and builds its ffmpeg command line.
//
// Capture uses Windows Desktop Duplication through ffmpeg's ddagrab filter. ddagrab hands frames over as
// GPU textures on the graphics card that drives the monitor, so the best encoder is the one on that same
// card: NVENC when the monitor is plugged into the GeForce, AMF when it is plugged into the motherboard
// (AMD graphics). Encoding on the card that already holds the frame avoids copying every frame through
// the CPU. If that fails, frames are copied to system memory and sent to whichever encoder works.

import { execFile } from 'node:child_process';
import { defaultBitrate, resolveResolution, type Settings } from '../settings';

export type EncoderId = 'nvenc' | 'amf' | 'qsv' | 'x264';

export interface EncoderChoice {
  id: EncoderId;
  /** true = ddagrab's GPU textures go straight into the encoder (no CPU copy). */
  gpuFrames: boolean;
}

export interface GpuAdapter {
  index: number;
  vendorId: string;
  deviceId: string;
  name: string;
  vendor: 'nvidia' | 'amd' | 'intel' | 'other';
}

export interface ProbeResult {
  ok: boolean;
  encoder?: EncoderChoice;
  width?: number;
  height?: number;
  adapters: GpuAdapter[];
  /** The card the captured monitor is connected to (adapter 0). */
  captureGpu?: GpuAdapter;
  tried: Array<{ encoder: string; ok: boolean; error?: string }>;
  problem?: string;
}

export const ENCODER_LABEL: Record<EncoderId, string> = {
  nvenc: 'NVIDIA NVENC',
  amf: 'AMD AMF',
  qsv: 'Intel Quick Sync',
  x264: 'CPU (x264)',
};

export function vendorOf(id: string): GpuAdapter['vendor'] {
  switch (id.toLowerCase()) {
    case '10de':
      return 'nvidia';
    case '1002':
    case '1022':
      return 'amd';
    case '8086':
      return 'intel';
    default:
      return 'other';
  }
}

/** Parses ffmpeg's "Using device 10de:2c02 (NVIDIA GeForce RTX 5080)." line. */
export function parseAdapterLine(stderr: string, index: number): GpuAdapter | undefined {
  const m = stderr.match(/Using device ([0-9a-f]{4}):([0-9a-f]{4}) \((.*?)\)\.?\s*$/im);
  if (!m) return undefined;
  return { index, vendorId: m[1].toLowerCase(), deviceId: m[2].toLowerCase(), name: m[3].trim(), vendor: vendorOf(m[1]) };
}

/** Parses the captured size from ffmpeg's input stream line. */
export function parseVideoSize(stderr: string): { width: number; height: number } | undefined {
  const line = stderr.split(/\r?\n/).find((l) => /Stream #\d+:\d+.*Video:/.test(l));
  const m = line?.match(/\b(\d{3,5})x(\d{3,5})\b/);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : undefined;
}

/** The order to try encoders in, given which card the monitor is on and which cards exist. */
export function encoderCandidates(adapters: GpuAdapter[], prefer: EncoderId | 'auto' = 'auto'): EncoderChoice[] {
  const capture = adapters[0]?.vendor ?? 'other';
  const has = (v: GpuAdapter['vendor']) => adapters.some((a) => a.vendor === v);
  const list: EncoderChoice[] = [];
  const add = (id: EncoderId, gpuFrames: boolean) => {
    if (!list.some((c) => c.id === id && c.gpuFrames === gpuFrames)) list.push({ id, gpuFrames });
  };
  if (prefer !== 'auto') {
    if (prefer !== 'x264' && prefer !== 'qsv') add(prefer, true);
    add(prefer, false);
  }
  if (capture === 'nvidia') add('nvenc', true);
  if (capture === 'amd') add('amf', true);
  if (capture === 'other') {
    add('nvenc', true);
    add('amf', true);
  }
  // The monitor is on a different card than the best encoder: copy frames through the CPU instead.
  if (has('nvidia') || capture === 'other') add('nvenc', false);
  if (has('amd') || capture === 'other') add('amf', false);
  if (has('intel') || capture === 'other') add('qsv', false);
  add('x264', false);
  return list;
}

export interface RecordOptions {
  outputIdx: number;
  fps: number;
  bitrateKbps: number;
  encoder: EncoderChoice;
  /** Only used on the CPU path: scale to this height (the GPU path records at monitor resolution). */
  cropLeft?: number;
  cropRight?: number;
  scaleHeight?: number;
  width?: number;
  height?: number;
}

/** Apply the UI's resolution choice, avoiding upscaling and bounding the CPU fallback's cost. */
export function planRecording(settings: Settings, native: { width: number; height: number }, encoder: EncoderChoice) {
  const requested = resolveResolution(settings.resolution, native);
  let factor = Math.min(1, requested.height / native.height);
  if (encoder.id === 'x264') factor = Math.min(factor, 1920 / native.width, 1080 / native.height);
  const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
  const height = even(native.height * factor);
  const width = Math.max(2, Math.round(native.width * height / native.height / 2) * 2);
  const scaled = width !== native.width || height !== native.height;
  const fps = encoder.id === 'x264' ? Math.min(60, settings.fps) : settings.fps;
  return {
    width, height, fps,
    bitrateKbps: settings.bitrateKbps || defaultBitrate(height, fps),
    // Bundled FFmpeg has no D3D11 scaling filter. Resizing needs a CPU copy, then GPU encoding.
    encoder: scaled ? { ...encoder, gpuFrames: false } : encoder,
    scaleHeight: scaled ? height : undefined,
  };
}

export function gameWindowSource(fps: number): string {
  return `gfxcapture=window_exe='(?i)^Marvel-Win64-Shipping[.]exe$':capture_cursor=0:max_framerate=${fps}`;
}

/** Video encoder flags. Keyframe every second and no B-frames, so clips can start on any second. */
export function encoderArgs(enc: EncoderChoice, fps: number, kbps: number): string[] {
  const rate = [`-b:v`, `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${kbps * 2}k`];
  const gop = ['-g', String(fps), '-bf', '0'];
  switch (enc.id) {
    case 'nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', ...rate, ...gop, '-spatial-aq', '1', '-forced-idr', '1'];
    case 'amf':
      return ['-c:v', 'h264_amf', '-usage', 'transcoding', '-quality', 'balanced', '-rc', 'vbr_peak', ...rate, ...gop];
    case 'qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'medium', ...rate, ...gop];
    case 'x264':
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '20', '-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${kbps * 2}k`, ...gop,
        '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
  }
}

/** The filter chain between ddagrab and the encoder. Empty when GPU textures go straight in. */
export function videoFilter(o: RecordOptions): string | undefined {
  if (o.encoder.gpuFrames) return undefined;
  const parts = ['hwdownload', 'format=bgra'];
  const h = o.scaleHeight && o.height && o.scaleHeight <= o.height ? o.scaleHeight : undefined;
  if (h) parts.push(`scale=-2:${h}:flags=bilinear`);
  switch (o.encoder.id) {
    case 'nvenc':
      parts.push('format=bgr0');
      break;
    case 'amf':
      break; // AMF converts BGRA on the GPU
    case 'qsv':
      parts.push('format=nv12');
      break;
    case 'x264':
      parts.push('scale=out_color_matrix=bt709:out_range=tv', 'format=yuv420p');
      break;
  }
  return parts.join(',');
}

/** Full recorder command: screen in, MPEG-TS on stdout (the replay buffer reads it). */
export function recordArgs(o: RecordOptions): string[] {
  const vf = videoFilter(o);
  // CPU encoding at 4K60 would eat the game's CPU time, so the CPU path is capped at 1080p.
  const kbps = o.bitrateKbps;
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'warning',
    '-f', 'lavfi', '-i', gameWindowSource(o.fps) + (o.cropLeft ? `:crop_left=${o.cropLeft}:crop_right=${o.cropRight}` : ''),
    ...(vf ? ['-vf', vf] : []),
    ...encoderArgs(o.encoder, o.fps, kbps),
    '-an',
    '-f', 'mpegts', '-muxdelay', '0', '-muxpreload', '0', '-flush_packets', '1',
    'pipe:1',
  ];
}

/** Muxes a saved clip: video copied as-is, game audio on track 1, mic on track 2. */
export function muxArgs(videoTs: string, audio: Array<{ file: string; label: 'game' | 'mic' }>, out: string): string[] {
  const args = ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'mpegts', '-i', videoTs];
  for (const a of audio) args.push('-i', a.file);
  args.push('-map', '0:v:0');
  audio.forEach((_, i) => args.push('-map', `${i + 1}:a:0`));
  args.push('-c:v', 'copy');
  if (audio.length) args.push('-c:a', 'aac', '-b:a', '192k');
  audio.forEach((a, i) => {
    args.push(`-metadata:s:a:${i}`, `title=${a.label === 'game' ? 'Game' : 'Mic'}`, `-disposition:a:${i}`, i === 0 ? 'default' : '0');
  });
  args.push('-movflags', '+faststart', out);
  return args;
}

// ---------- probing (runs ffmpeg) ----------

function run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number; err: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, _out, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, err: String(stderr) });
    });
  });
}

export async function listAdapters(ffmpeg: string): Promise<GpuAdapter[]> {
  const out: GpuAdapter[] = [];
  for (let i = 0; i < 4; i++) {
    const r = await run(ffmpeg, ['-hide_banner', '-loglevel', 'info', '-init_hw_device', `d3d11va=probe:${i}`, '-f', 'lavfi', '-i', 'nullsrc=s=16x16:d=0.04', '-f', 'null', '-'], 8000);
    const a = parseAdapterLine(r.err, i);
    if (!a) break;
    // The Basic Render Driver is Windows' software fallback, not a real card.
    if (!/basic render/i.test(a.name)) out.push(a);
  }
  return out;
}

function lastError(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (lines.reverse().find((l) => /error|fail|cannot|invalid|not/i.test(l)) ?? lines[0] ?? 'unknown error').slice(0, 300);
}

const probeCache = new Map<string, ProbeResult>();

/** Finds the first encoder that can actually record the monitor, with a short test capture. */
export async function probeCapture(ffmpeg: string, outputIdx: number, prefer: EncoderId | 'auto' = 'auto', force = false): Promise<ProbeResult> {
  const key = `${ffmpeg}|${outputIdx}|${prefer}`;
  const cached = probeCache.get(key);
  if (cached?.ok && !force) return cached;
  const adapters = await listAdapters(ffmpeg);
  const result: ProbeResult = { ok: false, adapters, captureGpu: adapters[0], tried: [] };
  for (const enc of encoderCandidates(adapters, prefer)) {
    const vf = videoFilter({ outputIdx, fps: 30, bitrateKbps: 8000, encoder: enc });
    const args = [
      '-hide_banner', '-nostdin', '-loglevel', 'info',
      '-f', 'lavfi', '-i', gameWindowSource(30),
      ...(vf ? ['-vf', vf] : []),
      ...encoderArgs(enc, 30, 8000),
      '-frames:v', '12', '-f', 'null', '-',
    ];
    const r = await run(ffmpeg, args, 20000);
    const label = `${enc.id}${enc.gpuFrames ? ' (GPU frames)' : ''}`;
    if (r.code === 0) {
      const size = parseVideoSize(r.err);
      Object.assign(result, { ok: true, encoder: enc, width: size?.width, height: size?.height });
      result.tried.push({ encoder: label, ok: true });
      probeCache.set(key, result);
      return result;
    }
    const error = lastError(r.err);
    result.tried.push({ encoder: label, ok: false, error });
    // Desktop Duplication itself failed: no encoder will help.
    if (/Failed to find capture source/i.test(r.err)) {
      result.problem = 'Waiting for the Marvel Rivals game window';
      break;
    }
    if (/gfxcapture|DXGI/i.test(error) && !/nvenc|amf|qsv|x264|encoder/i.test(error)) {
      result.problem = `Screen capture failed: ${error}`;
      break;
    }
  }
  result.problem ??= 'No video encoder worked. ' + result.tried.map((t) => `${t.encoder}: ${t.error}`).join('; ');
  return result;
}

export function describeProbe(p: ProbeResult): string {
  if (!p.ok || !p.encoder) return p.problem ?? 'Screen capture not available';
  const gpu = p.captureGpu?.name ?? 'your graphics card';
  const enc = ENCODER_LABEL[p.encoder.id];
  return p.encoder.gpuFrames ? `${enc} on ${gpu}` : `${enc} (frames copied from ${gpu})`;
}

/** Size of the monitor Desktop Duplication sees (grabs one frame). */
export async function probeScreenSize(ffmpeg: string, outputIdx: number): Promise<{ width: number; height: number } | undefined> {
  const r = await run(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'info', '-f', 'lavfi', '-i', gameWindowSource(5), '-frames:v', '1', '-f', 'null', '-'], 10000);
  return parseVideoSize(r.err);
}
