// Reads the names on your white kill-feed rows. Rivals puts every row you're in on a white plate:
// your kills ("you > them") and your deaths ("them > you") alike, so a white plate alone isn't a kill.
// A row is your kill only when the LEFT name is yours. The names also give away games against bots:
// their names end in "-Normal" (or another difficulty), e.g. "IRON MAN-Normal".
// Measured on Ferris's 2584x1080 clips (2026-11-11): 22-55-32 (his kill), 22-55-15 (his death on a white
// plate, "T1GRE510 > yaomingdiesel"), 18-26-38 (a vs-AI game).

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import type { Crop } from '../vision/image';
import type { ScreenOcr } from '../vision/ocr';
import type { OcrResult } from '../vision/fusion';
import { FEED_REGION, FEED_ROW } from './render';

export interface RowNames {
  /** The attacker (left) and victim (right), as read. Empty when nothing could be read. */
  left: string;
  right: string;
  /** Every word read, left to right. */
  words?: string[];
}

export type RowKind = 'kill' | 'death' | 'other' | 'unknown';

/** Rivals' AI opponents: "THOR-Normal", "IRON MAN-Hard". */
export const BOT_NAME = /[A-Z]{2,}\s?[-–\s]\s?(N[oa]rmal|Easy|Hard|Expert|Advanced|Beginner)\b/;

/** Letters OCR mixes up in the feed's font. */
const fold = (s: string) =>
  s.toLowerCase().replace(/[0o]/g, 'o').replace(/[1il|]/g, 'l').replace(/5/g, 's').replace(/8/g, 'b').replace(/[^a-z0-9]/g, '');

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return d[b.length];
}

/** True when an OCR read is close enough to one of your names (a letter or two wrong, or a cut-off end). */
export function sameName(read: string, name: string): boolean {
  const a = fold(read);
  const b = fold(name);
  if (a.length < 3 || b.length < 3) return false;
  if (a === b) return true;
  const allowed = b.length >= 9 ? 2 : 1;
  if (editDistance(a, b) <= allowed) return true;
  // The plate can clip the first letter or the portrait can eat it: allow a missing edge.
  return (a.length >= b.length - 2 && (b.includes(a) || a.includes(b)));
}

/** Any word of the read (or the whole of it) is one of your names: the portrait next to a name can read as a stray word. */
export const isMine = (read: string, names: string[]) => {
  const parts = [read, ...read.split(/\s+/)];
  return names.some((n) => parts.some((p) => sameName(p, n)));
};

/** What one of your white rows says: your kill, your death, or neither (an assist row, a misread). */
export function classifyRow(row: RowNames, names: string[]): RowKind {
  const words = row.words ?? [...row.left.split(/\s+/), ...row.right.split(/\s+/)].filter(Boolean);
  if (!names.length || !words.length) return 'unknown';
  // The row reads "attacker [ability] > victim". Your name first is your kill; a real name before
  // yours (not a stray letter or two from the portrait) is your death. Splitting on the gap between the
  // names is less reliable: the ability icon sometimes reads as a short word.
  const at = words.findIndex((w) => isMine(w, names));
  if (at < 0) return 'other';
  return words.slice(0, at).some((w) => w.replace(/[^A-Za-z0-9]/g, '').length >= 4) ? 'death' : 'kill';
}

export const isBotRow = (row: RowNames) => BOT_NAME.test(row.left) || BOT_NAME.test(row.right);

/**
 * Splits an OCR read of one row into the two names. The row is "[portrait] left [ability] > right [portrait]";
 * the ability icon and the chevron read as junk or not at all, so the names are the longest word runs
 * on each side of the gap between them.
 */
export function splitRow(r: OcrResult | undefined, width: number): RowNames {
  if (!r) return { left: '', right: '' };
  const words = r.words.filter((w) => /[A-Za-z0-9]{2,}/.test(w.text) && w.conf > 20);
  if (!words.length) return { left: '', right: '' };
  const all = [...words].sort((a, b) => a.x0 - b.x0).map((w) => w.text.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')).filter(Boolean);
  // Names keep their hyphen ("IRON MAN-Normal") and spaces join words of the same name.
  const clean = (s: string) => s.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
  // Biggest horizontal gap between consecutive words splits left from right.
  const sorted = [...words].sort((a, b) => a.x0 - b.x0);
  let cut = -1;
  let gap = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const g = sorted[i + 1].x0 - sorted[i].x1;
    if (g > gap) {
      gap = g;
      cut = i;
    }
  }
  if (cut < 0 || gap < width * 0.04) {
    // One run of text: it's on whichever half of the row it sits in.
    const text = sorted.map((w) => clean(w.text)).join(' ').trim();
    return sorted[0].x0 + (sorted[sorted.length - 1].x1 - sorted[0].x0) / 2 < width / 2 ? { left: text, right: '', words: all } : { left: '', right: text, words: all };
  }
  return {
    left: sorted.slice(0, cut + 1).map((w) => clean(w.text)).join(' ').trim(),
    right: sorted.slice(cut + 1).map((w) => clean(w.text)).join(' ').trim(),
    words: all,
  };
}

const isPlate = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b > 175 && Math.max(r, g, b) - Math.min(r, g, b) < 50;

/**
 * The text of a white row as dark ink on white: the darkest channel of each pixel, so the blue name
 * on the left and the orange one on the right both come out dark (in luma, orange text is nearly as
 * bright as the plate). Everything outside the plate (scenery, the portraits) is blanked, or it
 * reads as ink.
 */
export function inkFromRgb(rgb: Uint8Array, w: number, h: number): Crop {
  const data = new Uint8Array(w * h).fill(255);
  const plateCols: number[] = [];
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let y = 0; y < h; y++) {
      const o = (y * w + x) * 3;
      if (isPlate(rgb[o], rgb[o + 1], rgb[o + 2])) n++;
    }
    if (n >= h * 0.3) plateCols.push(x);
  }
  if (!plateCols.length) return { w, h, data };
  const x0 = plateCols[0];
  const x1 = plateCols[plateCols.length - 1];
  for (let y = 0; y < h; y++) {
    for (let x = x0; x <= x1; x++) {
      const o = (y * w + x) * 3;
      data[y * w + x] = Math.min(rgb[o], rgb[o + 1], rgb[o + 2]);
    }
  }
  return { w, h, data };
}

/** ffmpeg crop of one feed slot (0 = top), full resolution, without the victim's portrait at the right end. */
export function slotCropFilter(slot: number): string {
  const r = FEED_REGION;
  const boxH = r.y1 - r.y0;
  const top = r.y0 + boxH * (FEED_ROW.first + slot * FEED_ROW.pitch);
  const height = boxH * FEED_ROW.height;
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  const w = r6(r.width * 0.92);
  return `crop=w=trunc(ih*${w}/2)*2:h=trunc(ih*${r6(height)}/2)*2:x=trunc((iw-ih*${r6(r.right + r.width)})/2)*2:y=trunc(ih*${r6(top)}/2)*2`;
}

const cache = new Map<string, RowNames>();

/** Reads the names on one of your rows: a single frame, `at` seconds in, at the row's slot. */
export async function readRow(ffmpeg: string, ocr: ScreenOcr, file: string, at: number, slot: number, signal?: AbortSignal): Promise<RowNames> {
  let key = `${file}|${at.toFixed(2)}|${slot}`;
  try {
    const st = fs.statSync(file);
    key += `|${st.size}|${st.mtimeMs}`;
  } catch {
    return { left: '', right: '' };
  }
  const hit = cache.get(key);
  if (hit) return hit;
  const H = 40;
  const frame = await new Promise<{ rgb: Buffer; w: number } | null>((resolve) => {
    execFile(ffmpeg, ['-v', 'error', '-ss', Math.max(0, at).toFixed(3), '-i', file, '-frames:v', '1', '-vf', `${slotCropFilter(slot)},scale=-2:${H}:flags=bicubic,format=rgb24`, '-f', 'rawvideo', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 20_000, windowsHide: true, signal }, (error, out) => {
        if (error || !out.length) return resolve(null);
        resolve({ rgb: out, w: Math.round(out.length / 3 / H) });
      });
  });
  if (!frame) return { left: '', right: '' };
  const crop = inkFromRgb(frame.rgb, frame.w, H);
  const read = await ocr.read(crop, 'dark-text', 20_000);
  const names = splitRow(read, frame.w * Math.max(1, Math.min(6, Math.round(64 / H))));
  if (cache.size > 4000) cache.clear();
  cache.set(key, names);
  return names;
}

/**
 * Your names, learned from the rows themselves: every white row has you on it (left for a kill,
 * right for a death), so the name on most of them across many clips is yours. Ferris plays as two
 * names, so every name on at least a fifth of the rows (and in 3+ clips) counts.
 */
export function learnNames(rows: Array<{ clip: string; names: RowNames }>, known: string[] = []): string[] {
  const out = known.filter((n) => n.trim()).map((n) => n.trim());
  const counts = new Map<string, { name: string; rows: number; clips: Set<string>; spellings: Map<string, number> }>();
  for (const r of rows) {
    for (const side of [r.names.left, r.names.right]) {
      if (BOT_NAME.test(side)) continue;
      // The longest word: a stray letter from the portrait sits next to the name.
      const n = side.split(/\s+/).sort((a, b) => b.length - a.length)[0] ?? '';
      const f = fold(n);
      if (f.length < 3) continue;
      let entry = [...counts.values()].find((e) => sameName(n, e.name));
      if (!entry) counts.set(f, (entry = { name: n, rows: 0, clips: new Set(), spellings: new Map() }));
      entry.rows++;
      entry.clips.add(r.clip);
      entry.spellings.set(n, (entry.spellings.get(n) ?? 0) + 1);
    }
  }
  // Every row has you on it once. Take the most common name first; a second name (another account) counts only
  // on rows that don't already show one of yours, so an enemy who kills you again and again isn't learned as you.
  const spelling = (e: { spellings: Map<string, number> }) => [...e.spellings].sort((a, b) => b[1] - a[1])[0][0];
  const total = rows.length;
  if (total < 5) return out;
  let left = rows.filter((r) => !isMine(r.names.left, out) && !isMine(r.names.right, out));
  for (const e of [...counts.values()].sort((a, b) => b.rows - a.rows)) {
    const name = spelling(e);
    if (isMine(name, out)) continue;
    const hits = left.filter((r) => isMine(r.names.left, [name]) || isMine(r.names.right, [name]));
    if (hits.length >= Math.max(3, total * 0.2) && new Set(hits.map((r) => r.clip)).size >= 3) {
      out.push(name);
      left = left.filter((r) => !hits.includes(r));
    }
  }
  return out;
}

/**
 * Reads one of your rows (FeedRow from feed-rows.ts) once it has settled: a row slides in over its
 * first few frames, and reads as junk then. A second frame is tried when the first doesn't give a name.
 */
export async function readOwnRow(ffmpeg: string, ocr: ScreenOcr, file: string, row: { slot: number; from: number; to: number }, names: string[], signal?: AbortSignal): Promise<RowNames> {
  const times = [Math.min(row.from + 0.6, row.to - 0.15), (row.from + row.to) / 2 + 0.3].filter((t, i, a) => t > row.from && (i === 0 || Math.abs(t - a[0]) > 0.2));
  let first: RowNames | undefined;
  for (const t of times) {
    const r = await readRow(ffmpeg, ocr, file, t, row.slot, signal);
    first ??= r;
    const kind = classifyRow(r, names);
    if (kind === 'kill' || kind === 'death' || (!names.length && (r.words ?? []).some((w) => w.length >= 5))) return r;
  }
  return first ?? { left: '', right: '' };
}

/** One kill-feed onset of yours (feed-rows.ts rowOnsets) and what its row says. */
export interface OnsetRead {
  at: number;
  names: RowNames;
}

/**
 * The row that entered the feed at an onset, as a span to read from: the top slot at that moment (new rows
 * enter there). When your rows follow each other, the top slot is one continuous span in ownRows, so the
 * new row is read from the onset, not from where that span began (the earlier row).
 */
export function rowAtOnset<T extends { slot: number; from: number; to: number }>(rows: T[], onset: number): { slot: number; from: number; to: number } | undefined {
  const at = onset + 0.125;
  const top = rows.find((r) => r.slot === 0 && r.from <= at + 0.3 && r.to >= at + 0.2);
  if (top) return { slot: 0, from: Math.max(top.from, at), to: top.to };
  const near = rows.find((r) => Math.abs(r.from - at) <= 0.3);
  return near ? { slot: near.slot, from: near.from, to: near.to } : undefined;
}

/**
 * Sorts a clip's feed onsets: your kills stay, your deaths come out as deaths (your name on the right),
 * and rows that don't name you on the left (a misread plate, an assist) are dropped. Onsets whose row
 * couldn't be read stay, so a clip isn't emptied when text recognition fails.
 */
export function judgeHits(hits: number[], reads: OnsetRead[], names: string[]): { hits: number[]; deaths: number[]; bots: boolean; notMine: number } {
  const out: number[] = [];
  const deaths: number[] = [];
  let notMine = 0;
  for (const h of hits) {
    const r = reads.find((x) => Math.abs(x.at - h) < 0.05);
    const kind = r ? classifyRow(r.names, names) : 'unknown';
    if (kind === 'death') deaths.push(h);
    else if (kind === 'other') notMine++;
    else out.push(h);
  }
  return { hits: out, deaths, bots: reads.some((r) => isBotRow(r.names)), notMine };
}

/** Your names from the settings ("Ferrsir, yaomingdiesel" is fine). */
export const namesFromSetting = (s: string | undefined) => (s ?? '').split(/[,;/]+/).map((x) => x.trim()).filter((x) => x.length >= 3);
