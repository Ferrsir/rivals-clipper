// Runs the screen detector: HUD frames from ffmpeg (live screen or a recorded video) go through the
// analyzer, text recognition and fusion, and out come GEP-style events. The live app and the test
// harness both use this, so the harness measures exactly what runs while you play.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { gameWindowSource } from '../capture/encoder';
import { HudAnalyzer, type Observation } from './detectors';
import { ScreenFusion, type EventSink, type FusionCallbacks, type FusionOptions, type OcrResult } from './fusion';
import type { Crop } from './image';
import { hudFilterGraph, type HudLayout, type RegionId } from './layout';
import type { OcrMode, ScreenOcr } from './ocr';

export type FrameInput = { kind: 'screen'; outputIdx: number } | { kind: 'file'; path: string; startSec?: number; durationSec?: number };

export function frameSourceArgs(layout: HudLayout, fps: number, input: FrameInput): string[] {
  const common = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
  const out = ['-map', '[hud]', '-an', '-f', 'rawvideo', '-pix_fmt', 'bgra', 'pipe:1'];
  if (input.kind === 'screen') {
    return [...common, '-f', 'lavfi', '-i', gameWindowSource(fps), '-filter_complex', hudFilterGraph(layout, { gpuFrames: true, fps }), ...out];
  }
  return [
    ...common,
    ...(input.startSec ? ['-ss', String(input.startSec)] : []),
    '-i', input.path,
    ...(input.durationSec ? ['-t', String(input.durationSec)] : []),
    '-filter_complex', hudFilterGraph(layout, { gpuFrames: false, fps }),
    ...out,
  ];
}

/** Reads fixed-size BGRA mosaic frames from ffmpeg. Events: 'frame' (data, index, arrivedAt), 'exit' (code, why). */
export class FrameSource extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private frameBytes: number;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private index = 0;
  private stderr: string[] = [];

  constructor(private ffmpeg: string, private args: string[], layout: HudLayout) {
    super();
    this.frameBytes = layout.mosaicW * layout.mosaicH * 4;
  }

  start(): void {
    const proc = spawn(this.ffmpeg, this.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stdout.on('data', (d: Buffer) => this.onData(d));
    proc.stderr.on('data', (d: Buffer) => {
      this.stderr.push(...d.toString('utf8').split(/\r?\n/).filter((l) => l.trim()));
      if (this.stderr.length > 20) this.stderr.splice(0, this.stderr.length - 20);
    });
    proc.on('error', (err) => this.emit('exit', -1, err.message));
    proc.on('exit', (code) => {
      this.proc = undefined;
      this.emit('exit', code, this.stderr.slice(-3).join(' | '));
    });
  }

  /** Pause/resume reading, so a slow consumer (the harness waiting on OCR) holds ffmpeg back instead of buffering. */
  pause(): void {
    this.proc?.stdout.pause();
  }

  resume(): void {
    this.proc?.stdout.resume();
  }

  /** Nothing is written to disk, so ffmpeg can simply be ended. */
  stop(): void {
    const p = this.proc;
    if (!p) return;
    this.proc = undefined;
    p.kill();
  }

  get running(): boolean {
    return !!this.proc;
  }

  private onData(d: Buffer): void {
    this.pending.push(d);
    this.pendingBytes += d.length;
    while (this.pendingBytes >= this.frameBytes) {
      const all = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending);
      const frame = new Uint8Array(all.buffer.slice(all.byteOffset, all.byteOffset + this.frameBytes));
      const rest = all.subarray(this.frameBytes);
      this.pending = rest.length ? [rest] : [];
      this.pendingBytes = rest.length;
      this.emit('frame', frame, this.index++, Date.now());
    }
  }
}

const OCR_MODE: Record<'feed' | 'ko' | 'banner' | 'map' | 'outcome' | 'subtitle', OcrMode> = {
  subtitle: 'big-text',
  feed: 'dark-text',
  ko: 'light-text',
  banner: 'light-text',
  map: 'light-text',
  outcome: 'big-text',
};

export interface PipelineOptions extends FusionOptions {
  layout: HudLayout;
  frameMs: number;
  /** Harness: wait for each text read before the next frame, so results don't depend on machine speed. */
  awaitOcr?: boolean;
  koColumnX?: number;
}

/** Analyzer + OCR + fusion, fed one frame at a time. */
export class DetectionPipeline {
  readonly analyzer: HudAnalyzer;
  readonly fusion: ScreenFusion;
  private crops = new Map<string, Crop>();
  private inflight: Array<Promise<void>> = [];
  /** Every observation, for the harness report. */
  readonly trace: Observation[] = [];
  keepTrace = false;
  private clock = () => Date.now();

  constructor(sink: EventSink, private ocr: ScreenOcr | undefined, private o: PipelineOptions, cb: FusionCallbacks = {}) {
    this.analyzer = new HudAnalyzer(o.layout, { frameMs: o.frameMs, koColumnX: o.koColumnX });
    this.fusion = new ScreenFusion(sink, { ...o, ocr: !!ocr && o.ocr }, {
      ...cb,
      requestOcr: (req) => this.runOcr(req.kind, req.id),
      wantCrop: (region: RegionId) => this.analyzer.want(region),
    });
  }

  async processFrame(frame: Uint8Array, t: number): Promise<void> {
    if (this.o.awaitOcr) this.clock = () => t;
    const obs = this.analyzer.analyze(frame, t);
    for (const ob of obs) {
      if (ob.kind === 'feed-row' || ob.kind === 'ko-line' || ob.kind === 'banner') this.crops.set(`${kindOf(ob.kind)}:${ob.id}`, ob.crop);
      if (ob.kind === 'crop') this.crops.set(`${ob.region}:${ob.t}`, ob.crop);
      if (this.keepTrace && ob.kind !== 'hud') this.trace.push({ ...ob, crop: { w: 0, h: 0, data: new Uint8Array(0) } } as Observation);
      if (this.keepTrace && ob.kind === 'hud' && ob.matchHud) this.trace.push(ob);
      this.fusion.onObservation(ob);
    }
    // OCR requests take ownership synchronously above. Unrequested crops (notably
    // when OCR is off or failed) must not accumulate throughout a long session.
    this.crops.clear();
    if (this.o.awaitOcr && this.inflight.length) {
      const wait = this.inflight;
      this.inflight = [];
      await Promise.all(wait);
    }
    this.fusion.tick(t);
  }

  /** Flush decisions at the end of a recording. */
  finish(t: number): void {
    this.fusion.tick(t + 10_000);
  }

  private runOcr(kind: 'feed' | 'ko' | 'banner' | 'map' | 'outcome' | 'subtitle', id: number): void {
    const key = `${kind}:${id}`;
    const crop = this.crops.get(key);
    this.crops.delete(key);
    if (!crop || !this.ocr) {
      this.fusion.onOcr(kind, id, undefined, this.clock());
      return;
    }
    const p = this.ocr
      .read(crop, OCR_MODE[kind], this.o.awaitOcr ? 60_000 : 3000)
      .then((r: OcrResult | undefined) => this.fusion.onOcr(kind, id, r, this.clock()));
    this.inflight.push(p);
    if (!this.o.awaitOcr) void p.finally(() => (this.inflight = this.inflight.filter((x) => x !== p)));
  }
}

function kindOf(k: 'feed-row' | 'ko-line' | 'banner'): 'feed' | 'ko' | 'banner' {
  return k === 'feed-row' ? 'feed' : k === 'ko-line' ? 'ko' : 'banner';
}
