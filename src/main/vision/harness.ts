// Test harness: runs the screen detector over a recorded video and, given the true kill/death times,
// reports precision, recall and detection latency. Uses the same pipeline as the live app.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { parseVideoSize } from '../capture/encoder';
import type { EventSink } from './fusion';
import { DEFAULT_REGIONS, layoutFor, type RegionSpec } from './layout';
import { ScreenOcr } from './ocr';
import { DetectionPipeline, FrameSource, frameSourceArgs } from './pipeline';

export interface Labels {
  /** Seconds into the video where each of your KOs happens (when the KO shows on screen). */
  kills?: number[];
  deaths?: number[];
  /** The whole video is in the Practice Range (no auto-clips expected). */
  practice?: boolean;
  playerName?: string;
  /** Region preset or custom regions, for footage that isn't a plain screen recording. */
  layout?: 'screen' | 'tiktok-square';
  regions?: RegionSpec[];
  hudScale?: number;
  hudAspect?: number;
}

export interface DetectedEvent {
  type: string;
  /** Seconds into the video. */
  t: number;
  value?: unknown;
}

export interface Score {
  truePositives: number;
  falsePositives: number;
  missed: number;
  precision: number;
  recall: number;
  f1: number;
  /** Detected time minus true time, in ms (positive = late). */
  meanLatencyMs: number;
  maxLatencyMs: number;
  falseAt: number[];
  missedAt: number[];
}

export interface HarnessReport {
  video: string;
  width: number;
  height: number;
  frames: number;
  seconds: number;
  msPerFrame: number;
  ocrReads: number;
  ocrMsPerRead: number;
  events: DetectedEvent[];
  kills?: Score;
  deaths?: Score;
  practiceOk?: boolean;
  learnedName?: string;
}

/** Square TikTok-style edits of the game (centre crop, kill feed pasted top right), e.g. the reference videos. */
export const TIKTOK_SQUARE_REGIONS: RegionSpec[] = DEFAULT_REGIONS.map((r) =>
  r.id === 'feed' ? { ...r, x: -500, y: 0, w: 500, h: 240 } : r.id === 'map' ? { ...r, x: 0, y: 20, w: 400, h: 150 } : r,
);

export function score(detected: number[], truth: number[], toleranceSec = 1.5): Score {
  const used = new Set<number>();
  const latencies: number[] = [];
  const missedAt: number[] = [];
  for (const t of [...truth].sort((a, b) => a - b)) {
    let best = -1;
    let bestD = Infinity;
    detected.forEach((d, i) => {
      if (used.has(i)) return;
      const dist = Math.abs(d - t);
      if (dist <= toleranceSec && dist < bestD) [best, bestD] = [i, dist];
    });
    if (best >= 0) {
      used.add(best);
      latencies.push((detected[best] - t) * 1000);
    } else missedAt.push(t);
  }
  const tp = used.size;
  const fp = detected.length - tp;
  const precision = detected.length ? tp / detected.length : truth.length ? 0 : 1;
  const recall = truth.length ? tp / truth.length : 1;
  return {
    truePositives: tp,
    falsePositives: fp,
    missed: missedAt.length,
    precision,
    recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    meanLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
    maxLatencyMs: latencies.length ? Math.round(Math.max(...latencies)) : 0,
    falseAt: detected.filter((_, i) => !used.has(i)),
    missedAt,
  };
}

function probeSize(ffmpeg: string, file: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true }, (_err, _out, stderr) => {
      const s = parseVideoSize(String(stderr));
      if (s) resolve(s);
      else reject(new Error(`Could not read the video size of ${file}`));
    });
  });
}

export interface HarnessOptions {
  ffmpeg: string;
  video: string;
  labels?: Labels;
  fps?: number;
  ocr?: boolean;
  playerName?: string;
  startSec?: number;
  durationSec?: number;
  onProgress?: (seconds: number) => void;
}

export async function runHarness(o: HarnessOptions): Promise<HarnessReport> {
  const fps = o.fps ?? 10;
  const frameMs = 1000 / fps;
  const labels = o.labels ?? {};
  const size = await probeSize(o.ffmpeg, o.video);
  const regions = labels.regions ?? (labels.layout === 'tiktok-square' ? TIKTOK_SQUARE_REGIONS : DEFAULT_REGIONS);
  const layout = layoutFor(size.width, size.height, labels.hudScale ?? 1, regions, labels.hudAspect);
  const events: DetectedEvent[] = [];
  const base = 1_000_000_000_000; // fake epoch so times look like real ones
  let gameType: string | undefined;
  const practiceKills: number[] = [];
  const sink: EventSink = {
    gameEvent: (key, value, at) => {
      events.push({ type: key, t: (at - base) / 1000, value });
      if (key === 'match_start') gameType = undefined;
      if (key === 'kill' && gameType === 'Practice') practiceKills.push((at - base) / 1000);
    },
    infoUpdate: (_f, key, value) => {
      events.push({ type: `info:${key}`, t: NaN, value });
      if (key === 'game_type') gameType = String(value);
    },
  };
  let ocr: ScreenOcr | undefined;
  if (o.ocr !== false) {
    ocr = new ScreenOcr();
    if (!(await ocr.init())) ocr = undefined;
  }
  const pipeline = new DetectionPipeline(sink, ocr, {
    layout,
    frameMs,
    ocr: !!ocr,
    awaitOcr: true,
    playerName: o.playerName ?? labels.playerName,
    hudVerified: true,
    strictKills: true,
  });
  const src = new FrameSource(o.ffmpeg, frameSourceArgs(layout, fps, { kind: 'file', path: o.video, startSec: o.startSec, durationSec: o.durationSec }), layout);
  let frames = 0;
  let chain = Promise.resolve();
  const done = new Promise<void>((resolve, reject) => {
    src.on('frame', (frame: Uint8Array, index: number) => {
      src.pause();
      chain = chain.then(async () => {
        await pipeline.processFrame(frame, base + index * frameMs);
        frames = index + 1;
        if (index % (fps * 10) === 0) o.onProgress?.(index / fps);
        src.resume();
      });
    });
    src.on('exit', (code: number, why: string) => {
      void chain.then(() => (code === 0 || frames > 0 ? resolve() : reject(new Error(`ffmpeg failed: ${why}`))));
    });
  });
  src.start();
  await done;
  pipeline.finish(base + frames * frameMs);
  await ocr?.terminate();

  const at = (type: string) => events.filter((e) => e.type === type).map((e) => e.t);
  const report: HarnessReport = {
    video: o.video,
    width: size.width,
    height: size.height,
    frames,
    seconds: frames / fps,
    msPerFrame: Math.round((pipeline.analyzer.totalMs / Math.max(1, pipeline.analyzer.frames)) * 100) / 100,
    ocrReads: ocr?.reads ?? 0,
    ocrMsPerRead: ocr && ocr.reads ? Math.round(ocr.totalMs / ocr.reads) : 0,
    events,
    learnedName: pipeline.fusion.playerName,
  };
  if (labels.kills) report.kills = score(at('kill'), labels.kills);
  if (labels.deaths) report.deaths = score(at('death'), labels.deaths);
  if (labels.practice !== undefined) report.practiceOk = labels.practice ? practiceKills.length === at('kill').length : practiceKills.length === 0;
  return report;
}

export function readLabels(file: string): Labels {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Labels;
}

export function formatReport(r: HarnessReport): string {
  const lines = [
    `${r.video}`,
    `  ${r.width}x${r.height}, ${r.seconds.toFixed(1)} s, ${r.frames} frames, ${r.msPerFrame} ms/frame analysis, ${r.ocrReads} text reads (${r.ocrMsPerRead} ms each)`,
  ];
  const evs = r.events.filter((e) => !e.type.startsWith('info:') && e.type !== 'kill_feed');
  lines.push(`  events: ${evs.map((e) => `${e.type}@${e.t.toFixed(1)}s`).join(', ') || 'none'}`);
  const feed = r.events.filter((e) => e.type === 'kill_feed').map((e) => e.value as { attacker?: string; victim?: string });
  if (feed.length) lines.push(`  feed: ${feed.map((f) => `${f.attacker ?? '?'} > ${f.victim ?? '?'}`).join(', ')}`);
  if (r.learnedName) lines.push(`  your name: ${r.learnedName}`);
  for (const [name, s] of [['kills', r.kills], ['deaths', r.deaths]] as const) {
    if (!s) continue;
    lines.push(
      `  ${name}: precision ${(s.precision * 100).toFixed(0)}%, recall ${(s.recall * 100).toFixed(0)}%, F1 ${(s.f1 * 100).toFixed(0)}%, latency avg ${s.meanLatencyMs} ms / max ${s.maxLatencyMs} ms` +
        (s.falseAt.length ? `, false at ${s.falseAt.map((t) => t.toFixed(1)).join(' ')}` : '') +
        (s.missedAt.length ? `, missed at ${s.missedAt.map((t) => t.toFixed(1)).join(' ')}` : ''),
    );
  }
  if (r.practiceOk !== undefined) lines.push(`  practice range handled: ${r.practiceOk ? 'yes' : 'NO'}`);
  return lines.join('\n');
}
