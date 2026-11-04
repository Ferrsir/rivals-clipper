// Finds an ffmpeg that can do the Studio's work and checks what it supports.
// Order: the bundled ffmpeg-static build (known to have libx264 and every filter we use),
// FFMPEG_PATH, the Overwolf recorder's copy, then whatever is on PATH.

import { execFile } from 'node:child_process';
import fs from 'node:fs';

export interface FfmpegInfo {
  ok: boolean;
  path?: string;
  version?: string;
  gpuEncoders: string[];
  problem?: string;
}

const REQUIRED_FILTERS = ['perspective', 'eq', 'tmix', 'framerate', 'chromashift', 'sidechaincompress', 'loudnorm', 'atempo', 'concat'];

function run(bin: string, args: string[], timeoutMs = 15000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, out: String(stdout), err: String(stderr) });
    });
  });
}

function bundled(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    let p = require('ffmpeg-static') as string | null;
    if (!p) return undefined;
    // Packaged apps keep binaries outside the asar archive.
    p = p.replace(`app.asar${require('node:path').sep}`, `app.asar.unpacked${require('node:path').sep}`);
    return fs.existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

export function candidates(recorderFfmpeg?: string): string[] {
  const list = [bundled(), process.env.FFMPEG_PATH, recorderFfmpeg, 'ffmpeg'].filter((x): x is string => !!x);
  return [...new Set(list)];
}

let cached: FfmpegInfo | undefined;

export async function findFfmpeg(recorderFfmpeg?: string, force = false): Promise<FfmpegInfo> {
  if (cached?.ok && !force) return cached;
  let lastProblem = 'No ffmpeg found. Reinstall Rivals Clipper, or install ffmpeg and set FFMPEG_PATH.';
  for (const bin of candidates(recorderFfmpeg)) {
    const v = await run(bin, ['-hide_banner', '-version']);
    if (v.code !== 0) continue;
    const filters = await run(bin, ['-hide_banner', '-filters']);
    const encoders = await run(bin, ['-hide_banner', '-encoders']);
    const missing = REQUIRED_FILTERS.filter((f) => !new RegExp(`\\s${f}\\s`).test(filters.out));
    if (!/\slibx264\s/.test(encoders.out)) missing.push('libx264');
    if (missing.length) {
      lastProblem = `ffmpeg at ${bin} is missing ${missing.join(', ')}.`;
      continue;
    }
    const gpu: string[] = [];
    for (const enc of ['h264_nvenc', 'h264_amf', 'h264_qsv']) {
      if (!new RegExp(`\\s${enc}\\s`).test(encoders.out)) continue;
      // Listed is not the same as usable: try one tiny encode.
      const t = await run(bin, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=256x256:d=0.2', '-c:v', enc, '-f', 'null', '-'], 10000);
      if (t.code === 0) gpu.push(enc);
    }
    cached = { ok: true, path: bin, version: v.out.split('\n')[0]?.replace(/^ffmpeg version\s*/, '').split(' ')[0], gpuEncoders: gpu };
    return cached;
  }
  cached = { ok: false, gpuEncoders: [], problem: lastProblem };
  return cached;
}

/** Decode any audio file to mono float PCM at `rate`. */
export function decodeAudio(ffmpeg: string, file: string, rate: number): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpeg,
      ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr) || err.message));
        const buf = stdout as Buffer;
        const n = Math.floor(buf.length / 4);
        // Copy into a fresh, 4-byte-aligned buffer.
        resolve(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + n * 4)));
      },
    );
  });
}

/** Title and artist tags, when the file has them. */
export function readTags(ffmpeg: string, file: string): Promise<{ title?: string; artist?: string }> {
  return new Promise((resolve) => {
    execFile(ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-f', 'ffmetadata', '-'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (_err, stdout) => {
      const tags: { title?: string; artist?: string } = {};
      for (const line of String(stdout).split('\n')) {
        const m = line.match(/^(title|artist)=(.*)$/i);
        if (m) tags[m[1].toLowerCase() as 'title' | 'artist'] = m[2].trim().slice(0, 120);
      }
      resolve(tags);
    });
  });
}
