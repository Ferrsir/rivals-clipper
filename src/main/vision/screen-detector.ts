// The live screen detector: a second, light ffmpeg capture of the monitor at a few frames per second
// that only keeps the HUD regions (layout.ts), fed through the same pipeline the test harness scores.
// It only looks at the picture on the screen, like a viewer would. It never touches the game process.
//
// Runs separately from the recorder, so a detector problem never stops recording (and the other way round).

import fs from 'node:fs';
import path from 'node:path';
import { probeScreenSize } from '../capture/encoder';
import { localOptions, type Settings } from '../settings';
import type { EventSink } from './fusion';
import { DEFAULT_REGIONS, layoutFor, type HudLayout } from './layout';
import { ScreenOcr } from './ocr';
import { DetectionPipeline, FrameSource, frameSourceArgs } from './pipeline';

type Log = (msg: string, extra?: unknown) => void;

/** What the detector remembers between sessions. */
export interface DetectorMemory {
  /** The match bar has been recognised on this PC, so "no match bar" can mean the Practice Range. */
  hudVerified?: boolean;
  /** Your name, learned from the kill feed when it isn't set in Settings. */
  learnedName?: string;
  /** Screen size the memory was learned at. A different size clears hudVerified. */
  screen?: string;
}

export interface DetectorStatus {
  running: boolean;
  width?: number;
  height?: number;
  fps: number;
  /** Average analysis time per frame. */
  msPerFrame: number;
  framesAnalyzed: number;
  framesDropped: number;
  textReading: 'on' | 'off' | 'failed';
  textReadingProblem?: string;
  playerName?: string;
  hudVerified: boolean;
  inMatch: boolean;
  problem?: string;
}

export interface ScreenDetectorOptions {
  ffmpeg: () => Promise<string>;
  sink: EventSink;
  log: Log;
  /** Folder for the detector's memory file. */
  dataDir: () => string;
}

const MEMORY_FILE = 'screen-detector.json';

export class ScreenDetector {
  private src?: FrameSource;
  private pipeline?: DetectionPipeline;
  private ocr?: ScreenOcr;
  private layout?: HudLayout;
  private stopping = true;
  private restarts = 0;
  private restartTimer?: NodeJS.Timeout;
  private busy = false;
  private dropped = 0;
  private fps = 10;
  private problem?: string;
  private memory: DetectorMemory = {};
  private inMatch = false;
  private lastSettings?: Settings;
  /** Bumped by every start/stop, so a slow start that was overtaken gives up. */
  private gen = 0;

  constructor(private o: ScreenDetectorOptions) {}

  get running(): boolean {
    return !!this.src?.running;
  }

  async start(settings: Settings): Promise<void> {
    // Reserve ownership before the first await. An immediate stop/new start must win.
    const gen = this.gen + 1;
    await this.stop();
    if (gen !== this.gen) return;
    const stale = () => gen !== this.gen;
    this.stopping = false;
    this.lastSettings = settings;
    this.problem = undefined;
    const opts = localOptions(settings);
    this.fps = opts.detectionFps;
    const ffmpeg = await this.o.ffmpeg();
    if (stale()) return;
    const monitor = opts.captureMonitor;
    const size = await probeScreenSize(ffmpeg, monitor);
    if (stale()) return;
    if (!size) {
      this.problem = 'Could not read the screen size for kill detection';
      this.o.log(this.problem);
      this.scheduleRestart();
      return;
    }
    this.memory = this.loadMemory();
    const screenKey = `${size.width}x${size.height}@${opts.hudScale}`;
    if (this.memory.screen && this.memory.screen !== screenKey) this.memory.hudVerified = false;
    this.memory.screen = screenKey;
    this.saveMemory();

    this.layout = layoutFor(size.width, size.height, opts.hudScale, DEFAULT_REGIONS);
    if (opts.readScreenText) {
      this.ocr ??= new ScreenOcr();
      const ok = await this.ocr.init();
      if (!ok) this.o.log(`Text reading is off (${this.ocr.failed}). Kills still come from the KO list.`);
    }
    if (stale()) return;
    const ocrOn = !!this.ocr && !this.ocr.failed && opts.readScreenText;
    const frameMs = 1000 / this.fps;
    const pipeline = new DetectionPipeline(
      {
        gameEvent: (key, value, at) => {
          if (stale() || this.stopping) return;
          if (key === 'match_start') this.inMatch = true;
          if (key === 'match_end') this.inMatch = false;
          this.o.sink.gameEvent(key, value, at);
        },
        infoUpdate: (feature, key, value) => {
          if (!stale() && !this.stopping) this.o.sink.infoUpdate(feature, key, value);
        },
      },
      ocrOn ? this.ocr : undefined,
      {
        layout: this.layout,
        frameMs,
        ocr: ocrOn,
        playerName: opts.playerName || this.memory.learnedName,
        hudVerified: !!this.memory.hudVerified,
      },
      {
        onHudVerified: () => {
          if (stale() || this.stopping) return;
          this.memory.hudVerified = true;
          this.saveMemory();
        },
        onNameLearned: (name) => {
          if (stale() || this.stopping) return;
          this.memory.learnedName = name;
          this.saveMemory();
          this.o.log(`Learned your in-game name from the kill feed: ${name}`);
        },
      },
    );
    this.pipeline = pipeline;
    pipeline.fusion.begin(Date.now());

    const src = new FrameSource(ffmpeg, frameSourceArgs(this.layout, this.fps, { kind: 'screen', outputIdx: monitor }), this.layout);
    this.src = src;
    src.on('frame', (frame: Uint8Array, _index: number, arrivedAt: number) => {
      // Never queue frames: if analysis falls behind, skip one rather than lag behind the game.
      if (this.busy) {
        this.dropped++;
        return;
      }
      this.busy = true;
      void pipeline
        .processFrame(frame, arrivedAt)
        .catch((err) => this.o.log('Kill detection error', String(err)))
        .finally(() => (this.busy = false));
    });
    src.on('exit', (code: number, why: string) => {
      if (this.src !== src) return;
      this.src = undefined;
      if (this.stopping) return;
      this.problem = `Kill detection capture stopped (code ${code})${why ? `: ${why}` : ''}`;
      this.o.log(this.problem);
      this.scheduleRestart();
    });
    src.start();
    this.o.log(`Kill detection running at ${this.fps} fps on a ${size.width}x${size.height} screen${ocrOn ? ', reading names' : ''}`);
    this.restarts = 0;
  }

  async stop(): Promise<void> {
    this.gen++;
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const src = this.src;
    this.src = undefined;
    src?.stop();
    if (this.pipeline) this.pipeline.finish(Date.now());
    this.pipeline = undefined;
    this.inMatch = false;
  }

  /** Frees the text model too (when the game closes). */
  async shutdown(): Promise<void> {
    await this.stop();
    await this.ocr?.terminate();
    this.ocr = undefined;
  }

  status(): DetectorStatus {
    const a = this.pipeline?.analyzer;
    return {
      running: this.running,
      width: this.layout?.screenW,
      height: this.layout?.screenH,
      fps: this.fps,
      msPerFrame: a && a.frames ? Math.round((a.totalMs / a.frames) * 10) / 10 : 0,
      framesAnalyzed: a?.frames ?? 0,
      framesDropped: this.dropped,
      textReading: !this.ocr ? 'off' : this.ocr.failed ? 'failed' : 'on',
      textReadingProblem: this.ocr?.failed,
      playerName: this.pipeline?.fusion.playerName,
      hudVerified: !!this.memory.hudVerified,
      inMatch: this.inMatch,
      problem: this.problem,
    };
  }

  /** Forget the learned name and HUD check (e.g. after changing account or HUD settings). */
  resetMemory(): void {
    this.memory = {};
    this.saveMemory();
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer || !this.lastSettings) return;
    const delay = Math.min(30_000, 2000 * 2 ** Math.min(4, this.restarts++));
    const settings = this.lastSettings;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.stopping) return;
      this.start(settings).catch((err) => this.o.log(`Kill detection restart failed: ${(err as Error).message}`));
    }, delay);
  }

  private memoryPath(): string {
    return path.join(this.o.dataDir(), MEMORY_FILE);
  }

  private loadMemory(): DetectorMemory {
    try {
      const m = JSON.parse(fs.readFileSync(this.memoryPath(), 'utf8')) as DetectorMemory;
      return m && typeof m === 'object' ? m : {};
    } catch {
      return {};
    }
  }

  private saveMemory(): void {
    try {
      fs.mkdirSync(this.o.dataDir(), { recursive: true });
      fs.writeFileSync(this.memoryPath(), JSON.stringify(this.memory, null, 2));
    } catch {
      /* not critical */
    }
  }
}
