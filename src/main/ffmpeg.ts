// Export helpers that use the ffmpeg binary shipped with Overwolf's recorder package.
// Clips keep game audio on track 1 and mic on track 2, so the mic can be dropped or mixed per clip.

import { execFile } from 'node:child_process';
import path from 'node:path';

function run(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args], (err, _out, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });
}

/** Export a single-audio-track copy: game only, or game + mic mixed. */
export async function exportClip(
  ffmpeg: string,
  videoFile: string,
  outDir: string,
  opts: { withMic: boolean; micVolume?: number; hasMicTrack: boolean },
): Promise<string> {
  const base = path.basename(videoFile).replace(/\.[^.]+$/, '');
  const out = path.join(outDir, `${base}${opts.withMic ? '_mic' : '_gameonly'}.mp4`);
  if (opts.withMic && opts.hasMicTrack) {
    const vol = opts.micVolume ?? 1;
    await run(ffmpeg, [
      '-i', videoFile,
      '-filter_complex', `[0:a:1]volume=${vol}[m];[0:a:0][m]amix=inputs=2:normalize=0[a]`,
      '-map', '0:v:0', '-map', '[a]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart', out,
    ]);
  } else {
    await run(ffmpeg, ['-i', videoFile, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart', out]);
  }
  return out;
}
