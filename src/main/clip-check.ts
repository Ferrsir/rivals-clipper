// Checks a clip right after it is saved, on the saved file itself, for the two things a clip must not
// show (Ferris, 2026-11-10: "its still showing clips of a defeated screen"):
//   - you dying and the death screen after it: the clip is cut just after the death;
//   - kills "made" while you were already dead (the replay of your death shows your killer's view, with
//     your name in their KO list): such a clip is dropped (moved to the Recycle Bin).
// The live detector already does both from the screen; this is the backstop, on the exact footage
// the clip contains, so a missed frame live can't leave a death screen in the Library.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import {
  COUNTDOWN_BOX, DEATH_BOX, DEATH_MIN, countdownCropFilter, countdownInRgb, deadSpans, deathCropFilter, deathScore, unpad, type DeadSample, type DeadSpan,
} from './vision/death-screen';

/** Samples per second. */
export const CHECK_FPS = 4;
/** A KO up to this long after a death seen as it happened still counts (a projectile, or a slow feed). */
const GRACE_S = 1.5;
/** Footage kept after the moment you died. */
const TAIL_S = 1;
/** Footage kept after the last kill when cutting. */
const AFTER_KILL_S = 0.7;

export type ClipVerdict =
  | { action: 'keep' }
  | { action: 'trim'; untilSec: number; reason: string }
  | { action: 'reject'; reason: string };

/** True when a kill at `t` seconds happened while you were dead. */
export function killWhileDead(t: number, spans: DeadSpan[]): boolean {
  return spans.some((s) => t > s.from + (s.fresh ? GRACE_S : -0.25) && t <= s.to + 0.25);
}

/**
 * What to do with a clip, from its death-screen samples and the times (seconds into the clip) of its kills.
 * Assists don't make a clip worth keeping on their own here (they only start clips when clipAssists is on,
 * and the same rule applies to them).
 */
export function judgeClip(samples: DeadSample[], killTimes: number[], durationSec: number, step = 1 / CHECK_FPS): ClipVerdict {
  if (!killTimes.length || !samples.length) return { action: 'keep' };
  const spans = deadSpans(samples, step);
  if (!spans.length) return { action: 'keep' };
  const valid = killTimes.filter((t) => !killWhileDead(t, spans)).sort((a, b) => a - b);
  if (!valid.length) return { action: 'reject', reason: 'every kill in it happened while you were dead (death screen on)' };
  const first = valid[0];
  // The first death not over before your first real kill (that kill may land just after it): the clip ends there.
  const death = spans.find((s) => s.to + 0.25 >= first);
  if (!death) return { action: 'keep' };
  // A real kill after you respawned (the clip spans a whole death): keep it all rather than lose that kill.
  if (valid.some((t) => t > death.to)) return { action: 'keep' };
  const lastBefore = valid.filter((t) => t <= death.from + (death.fresh ? GRACE_S : 0)).pop() ?? first;
  const untilSec = Math.max(death.from + TAIL_S, lastBefore + AFTER_KILL_S);
  if (untilSec >= durationSec - 0.5) return { action: 'keep' };
  return { action: 'trim', untilSec: Math.round(untilSec * 100) / 100, reason: `you died at ${death.from.toFixed(2)} s` };
}

/** The countdown and the "DEFEATED BY" card, sampled CHECK_FPS times a second over the whole clip. */
export function scanDeathScreen(ffmpeg: string, file: string, hudScale = 1): Promise<DeadSample[]> {
  const W = Math.max(COUNTDOWN_BOX.w, DEATH_BOX.w);
  const graph =
    `[0:v]fps=${CHECK_FPS},split=2[a][b];` +
    `[a]${countdownCropFilter(hudScale)},scale=${COUNTDOWN_BOX.w}:${COUNTDOWN_BOX.h}:flags=area,format=rgb24,pad=${W}:${COUNTDOWN_BOX.h}:0:0[cd];` +
    `[b]${deathCropFilter(hudScale)},scale=${DEATH_BOX.w}:${DEATH_BOX.h}:flags=area,format=rgb24,pad=${W}:${DEATH_BOX.h}:0:0[card];` +
    `[cd][card]vstack=inputs=2[out]`;
  return new Promise((resolve, reject) => {
    // Two threads, so the check never competes with the game for the whole CPU.
    execFile(ffmpeg, ['-v', 'error', '-threads', '2', '-i', file, '-t', '120', '-filter_complex', graph, '-map', '[out]', '-an', '-f', 'rawvideo', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true }, (error, out) => {
        if (error) return reject(error);
        const cdBytes = W * COUNTDOWN_BOX.h * 3;
        const size = cdBytes + W * DEATH_BOX.h * 3;
        const samples: DeadSample[] = [];
        for (let f = 0; (f + 1) * size <= out.length; f++) {
          const frame = out.subarray(f * size, (f + 1) * size);
          samples.push({
            t: f / CHECK_FPS,
            countdown: countdownInRgb(unpad(frame.subarray(0, cdBytes), W, COUNTDOWN_BOX.w, COUNTDOWN_BOX.h)),
            card: deathScore(unpad(frame.subarray(cdBytes), W, DEATH_BOX.w, DEATH_BOX.h)) >= DEATH_MIN,
          });
        }
        resolve(samples);
      });
  });
}

function run(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 120_000 }, (err, _out, stderr) => {
      if (err) reject(new Error(String(stderr).trim().split(/\r?\n/).slice(-3).join(' | ') || err.message));
      else resolve();
    });
  });
}

/** Cuts the clip to its first `untilSec` seconds in place (no re-encode) and redraws its cover. */
export async function trimClipFile(ffmpeg: string, file: string, untilSec: number): Promise<void> {
  const tmp = file.replace(/\.mp4$/i, '.trim.mp4');
  try {
    await run(ffmpeg, ['-y', '-v', 'error', '-i', file, '-t', String(untilSec), '-map', '0', '-c', 'copy', '-movflags', '+faststart', tmp]);
    await fs.promises.rename(tmp, file);
  } finally {
    await fs.promises.unlink(tmp).catch(() => undefined);
  }
  const cover = file.replace(/\.mp4$/i, '.cover.jpg');
  await run(ffmpeg, ['-y', '-v', 'error', '-ss', String(Math.min(5, untilSec / 2)), '-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', cover]).catch(() => undefined);
}
