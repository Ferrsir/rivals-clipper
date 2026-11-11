// Shots and song breaks for clips you bring in yourself (an anime edit, a TikTok).
//
// An anime clip is several shots (the pond, the bridge, a close-up). Each needs its own 9:16 crop and its
// own face picture, at that shot's face size, so the clip is split at its scene cuts into one clip per shot.
// The song's quiet break is where a cutaway to that clip goes, when a prompt asks for "the anime in the
// middle": the gameplay stops, the clip plays in sync with the song, and the gameplay comes back after.

import { execFile } from 'node:child_process';
import type { ImageOverlay, MusicAnalysis, ReelClip } from '../../shared/studio';

/** A scene change scores above this in ffmpeg's scene detection (0..1). */
export const SCENE_MIN = 0.3;
/** Shots shorter than this join the next one (a flash, a smoke puff). */
export const SHOT_MIN = 0.35;

/** Times (clip seconds) of hard cuts between `from` and `to`. */
export function sceneCuts(ffmpeg: string, file: string, from: number, to: number, signal?: AbortSignal): Promise<number[]> {
  return new Promise((resolve) => {
    execFile(ffmpeg, ['-hide_banner', '-ss', from.toFixed(3), '-i', file, '-t', Math.max(0.1, to - from).toFixed(3), '-an', '-vf', `scale=320:-2,select='gt(scene,${SCENE_MIN})',showinfo`, '-f', 'null', '-'],
      { maxBuffer: 16 * 1024 * 1024, timeout: 120_000, windowsHide: true, signal }, (error, _out, err) => {
        if (error) return resolve([]);
        resolve(parseShowinfo(String(err)).map((t) => Math.round((from + t) * 1000) / 1000));
      });
  });
}

/** pts_time of each frame ffmpeg's showinfo printed. */
export function parseShowinfo(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/pts_time:\s*([0-9.]+)/g)) out.push(Number(m[1]));
  return out.filter(Number.isFinite);
}

/** Shot spans [a, b) of a clip's used part, given its cuts. Short slivers join the shot after them. */
export function shotSpans(inn: number, out: number, cuts: number[]): Array<[number, number]> {
  const inside = [...new Set(cuts)].filter((t) => t > inn + SHOT_MIN && t < out - SHOT_MIN).sort((a, b) => a - b);
  const spans: Array<[number, number]> = [];
  let a = inn;
  for (const t of inside) {
    if (t - a < SHOT_MIN) continue;
    spans.push([a, t]);
    a = t;
  }
  spans.push([a, out]);
  return spans;
}

/**
 * One clip per shot, so each can have its own crop and pictures. The pictures on the clip are copied to
 * every shot they cover, without their face track: the face is looked for again in each shot (and the
 * picture dropped from a shot where that face isn't).
 */
export function splitIntoShots(clip: ReelClip, cuts: number[], overlays: ImageOverlay[], newId: () => string): { clips: ReelClip[]; overlays: ImageOverlay[] } {
  const spans = shotSpans(clip.in, clip.out, cuts);
  if (spans.length < 2) return { clips: [clip], overlays };
  const mine = overlays.filter((o) => o.clipUid === clip.uid);
  const rest = overlays.filter((o) => o.clipUid !== clip.uid);
  const clips: ReelClip[] = [];
  const outOverlays: ImageOverlay[] = [...rest];
  spans.forEach(([a, b], i) => {
    const shot: ReelClip = {
      ...clip,
      uid: i === 0 ? clip.uid : newId(),
      in: a,
      out: b,
      shotOf: clip.uid,
      // Only the last shot holds its frame or fades out; the first fades in.
      holdBeats: i === spans.length - 1 ? clip.holdBeats : undefined,
      fadeIn: i === 0 ? clip.fadeIn : undefined,
      fadeOut: i === spans.length - 1 ? clip.fadeOut : undefined,
      hits: clip.hits.filter((h) => h >= a && h < b),
    };
    shot.kills = clip.external ? shot.kills : shot.hits.length;
    clips.push(shot);
    for (const o of mine) {
      if (o.to <= a || o.from >= b) continue;
      outOverlays.push({ ...o, id: i === 0 ? o.id : newId(), clipUid: shot.uid, from: Math.max(a, o.from), to: Math.min(b, o.to), track: undefined });
    }
  });
  return { clips, overlays: outOverlays };
}

/** Horizontal crop centre (0..1) that keeps a shot's face pictures in frame: the average of their tracks. */
export function shotCropX(overlays: ImageOverlay[], uid: string): number | undefined {
  const xs = overlays.filter((o) => o.clipUid === uid).flatMap((o) => (o.track?.length ? o.track.map((k) => k.x) : [o.x]));
  if (!xs.length) return undefined;
  return Math.min(1, Math.max(0, xs.reduce((s, x) => s + x, 0) / xs.length));
}

/**
 * The song's quiet break: the longest run of beats well under the song's usual loudness, at least `min`
 * seconds long, after `after`. Returns [start, end] in song seconds, the end on the beat where it comes back.
 */
export function songBreak(an: MusicAnalysis, after = 0, min = 1.5): [number, number] | undefined {
  if (an.beats.length < 8 || an.beatEnergy.length !== an.beats.length) return undefined;
  const sorted = [...an.beatEnergy].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const quiet = an.beatEnergy.map((e) => e < median * 0.45);
  let best: [number, number] | undefined;
  for (let i = 0; i < quiet.length; i++) {
    if (!quiet[i] || an.beats[i] < after) continue;
    let j = i;
    while (j + 1 < quiet.length && quiet[j + 1]) j++;
    const start = an.beats[i];
    const end = an.beats[j + 1] ?? an.durationSec;
    if (end - start >= min && (!best || end - start > best[1] - best[0])) best = [start, end];
    i = j;
  }
  return best;
}

/**
 * Who each picture goes on, from the prompt: "magik icon on maki and deadpool on naoya" gives
 * [{ picture: 'magik', who: 'maki' }, { picture: 'deadpool', who: 'naoya' }].
 */
export function faceTargets(text: string): Array<{ picture: string; who: string }> {
  const out: Array<{ picture: string; who: string }> = [];
  const t = text.toLowerCase().replace(/[’']s\b/g, '');
  const re = /\b([a-z0-9]{3,20})(?:\s+(?:icon|picture|pic|image|face|head|pfp|logo|png))?\s+(?:on|over)\s+(?:top of\s+)?(?:the\s+)?([a-z0-9]{3,20})(?:\s+face|\s+head)?\b/g;
  const SKIP = /^(the|put|and|his|her|their|with|song|music|track|beat|top|screen|video|clip|reel|tiktok|it|that|this)$/;
  for (const m of t.matchAll(re)) {
    if (SKIP.test(m[1]) || SKIP.test(m[2])) continue;
    if (!out.some((x) => x.picture === m[1])) out.push({ picture: m[1], who: m[2] });
  }
  return out;
}

/** The person a picture overlay goes on, matched by its file name ("Lord_Icon_Magik.webp" is the magik one). */
export function targetFor(image: string, targets: Array<{ picture: string; who: string }>): string | undefined {
  const name = image.toLowerCase().replace(/\\/g, '/').split('/').pop() ?? '';
  return targets.find((x) => name.includes(x.picture))?.who;
}
