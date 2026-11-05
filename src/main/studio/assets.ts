// Your own videos and pictures, dropped into the Studio for a reel ("here's a clip and a picture,
// put the picture over his face"). Files are referenced where they are, never copied or changed.

import { execFile } from 'node:child_process';
import path from 'node:path';
import type { MediaAsset } from '../../shared/studio';
import { newId } from './projects';

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'bmp'];
export const VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'];

/** Read duration, size and whether there's sound from `ffmpeg -i` (the bundled build has no ffprobe). */
export function parseProbe(stderr: string): { durationSec?: number; width?: number; height?: number; hasAudio: boolean } {
  const d = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const v = stderr.match(/Stream #\d+:\d+[^\n]*Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
  return {
    durationSec: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : undefined,
    width: v ? Number(v[1]) : undefined,
    height: v ? Number(v[2]) : undefined,
    hasAudio: /Stream #\d+:\d+[^\n]*Audio:/.test(stderr),
  };
}

export function probeMedia(ffmpeg: string, file: string): Promise<ReturnType<typeof parseProbe>> {
  return new Promise((resolve) => {
    execFile(ffmpeg, ['-hide_banner', '-i', file], { timeout: 20_000, windowsHide: true }, (_e, _out, err) => resolve(parseProbe(String(err ?? ''))));
  });
}

export async function importAssets(ffmpeg: string, files: string[]): Promise<MediaAsset[]> {
  const out: MediaAsset[] = [];
  for (const file of files.slice(0, 20)) {
    const ext = path.extname(file).slice(1).toLowerCase();
    const kind = IMAGE_EXTS.includes(ext) ? 'image' : VIDEO_EXTS.includes(ext) ? 'video' : null;
    if (!kind) continue;
    const info = await probeMedia(ffmpeg, file);
    if (kind === 'video' && !info.durationSec) throw new Error(`Couldn't read ${path.basename(file)} as a video.`);
    out.push({ id: newId(), kind, file, name: path.basename(file), durationSec: kind === 'video' ? info.durationSec : undefined, width: info.width, height: info.height, hasAudio: kind === 'video' ? info.hasAudio : undefined });
  }
  return out;
}
