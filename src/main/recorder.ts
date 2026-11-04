// Wraps Overwolf's recorder package: a rolling replay buffer of the game window,
// game audio on track 1 and (optionally) your mic on track 2.

import { app } from 'electron';
import path from 'node:path';
import { Settings, defaultBitrate, resolveResolution } from './settings';

type RecorderApi = Electron.App['overwolf']['packages']['recorder'];
type ActiveReplay = Awaited<ReturnType<RecorderApi['captureReplay']>>;
type ReplayVideo = Parameters<NonNullable<Parameters<RecorderApi['captureReplay']>[1]>>[0];

/** AudioTracks is a bitmask: track 1 = 1, track 2 = 2. */
const TRACK_GAME = 1;
const TRACK_MIC = 2;

export interface GameProcess {
  pid?: number;
  fullPath?: string;
}

export interface BufferInfo {
  width: number;
  height: number;
  fps: number;
  micRecorded: boolean;
}

export class Recorder {
  private active?: ActiveReplay;
  info?: BufferInfo;

  constructor(private log: (msg: string, extra?: unknown) => void) {}

  get api(): RecorderApi {
    return app.overwolf.packages.recorder;
  }

  get ffmpegPath(): string | undefined {
    try {
      return this.api.ffmpegPath;
    } catch {
      return undefined;
    }
  }

  async listMics(): Promise<Array<{ id: string; name: string; isDefault: boolean }>> {
    const info = await this.api.queryInformation();
    return info.audio.inputDevices.map((d) => ({ id: d.id, name: d.name, isDefault: d.isDefault }));
  }

  async start(settings: Settings, game: GameProcess, clipsFolder: string): Promise<BufferInfo> {
    if (await this.api.isReplayActive()) await this.api.stopReplays();

    const info = await this.api.queryInformation();
    const primary = info.monitors.find((m) => m.isPrimary) ?? info.monitors[0];
    const native = primary ? { width: primary.rect.width, height: primary.rect.height } : { width: 1920, height: 1080 };
    const res = resolveResolution(settings.resolution, native);

    const builder = await this.api.createSettingsBuilder({ includeDefaultAudioSources: false });
    builder.videoSettings.baseWidth = res.width;
    builder.videoSettings.baseHeight = res.height;
    builder.videoSettings.outputWidth = res.width;
    builder.videoSettings.outputHeight = res.height;
    builder.videoSettings.fps = settings.fps;
    builder.videoEncoderSettings.bitrate = settings.bitrateKbps || defaultBitrate(res.height, settings.fps);
    // 1-second keyframes so clips start close to the moment we ask for.
    builder.videoEncoderSettings.keyint_sec = 1;

    // Prefer capturing the game itself. If we only know the game is running (no process info),
    // fall back to capturing the primary monitor, which also works for borderless fullscreen.
    const gameProcess = game.pid ?? (game.fullPath ? path.basename(game.fullPath) : undefined);
    if (gameProcess !== undefined) builder.addGameSource({ gameProcess, captureCursor: false });
    else if (primary) builder.addScreenSource({ monitorId: primary.id, captureCursor: false });
    else throw new Error('No game process and no monitor found to capture');

    if (settings.gameAudio === 'game-only' && game.fullPath) {
      builder.addApplicationAudioCapture({ processName: path.basename(game.fullPath) }, { tracks: TRACK_GAME });
    } else {
      builder.addAudioDefaultCapture('output', undefined, { tracks: TRACK_GAME });
    }

    let micRecorded = false;
    if (settings.recordMic) {
      const mics = info.audio.inputDevices;
      const chosen = settings.micDeviceId === 'default' ? undefined : mics.find((m) => m.id === settings.micDeviceId);
      if (chosen) builder.addAudioCapture({ id: chosen.id, name: chosen.name }, { tracks: TRACK_MIC });
      else builder.addAudioDefaultCapture('input', undefined, { tracks: TRACK_MIC });
      micRecorded = true;
    }

    const capture = builder.build();
    await this.api.startReplays(
      {
        bufferSecond: settings.bufferSeconds,
        rootFolder: clipsFolder,
        fileFormat: 'mp4',
        audioTrack: micRecorded ? TRACK_GAME | TRACK_MIC : TRACK_GAME,
        autoShutdownOnGameExit: true,
      },
      capture,
    );
    this.info = { width: res.width, height: res.height, fps: settings.fps, micRecorded };
    this.log('replay buffer started', { ...this.info, source: gameProcess ?? 'primary monitor', encoder: capture.videoEncoderSettings.type });
    return this.info;
  }

  async stop(): Promise<void> {
    if (this.active) this.active.stop();
    this.active = undefined;
    if (await this.api.isReplayActive()) await this.api.stopReplays();
  }

  /** Start saving a clip that includes the last `pastDurationMs`. Keeps recording until stopClip(). */
  async startClip(fileName: string, pastDurationMs: number, onDone: (v: ReplayVideo) => void): Promise<void> {
    if (this.active) return;
    this.active = await this.api.captureReplay({ fileName, pastDuration: pastDurationMs }, (video) => {
      this.active = undefined;
      onDone(video);
    });
  }

  stopClip(): void {
    this.active?.stop();
  }

  get clipInProgress(): boolean {
    return this.active !== undefined;
  }
}
