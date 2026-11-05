import { execFile } from 'node:child_process';

/** Inspect actual streams, including old clips whose sidecars predate silent capture. */
export function audioStreamCount(ffmpeg: string, file: string, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-map', '0:v:0', '-t', '0', '-f', 'null', '-'],
      { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024, signal }, (error, _out, stderr) => {
        if (error) return reject(new Error(signal?.aborted ? 'cancelled' : stderr || error.message));
        const input = stderr.split('Output #')[0];
        resolve((input.match(/Stream #0:\d+[^\r\n]*: Audio:/g) ?? []).length);
      });
  });
}
