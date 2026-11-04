// The local recorder: no Overwolf. ffmpeg captures the monitor with Desktop Duplication and encodes on
// the GPU (see encoder.ts). The encoded stream stays in memory (ts-buffer.ts) and rc-audio.exe keeps the
// game's sound and your mic in memory too (audio-helper.ts). Saving a clip writes only those seconds to
// disk and muxes them into an MP4 with game audio on track 1 and mic on track 2, the same layout as
// Overwolf clips, so the Library and Studio treat both the same.

import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Settings, defaultBitrate, localOptions } from '../settings';
import { wavHeader } from './audio-buffer';
import { AUDIO_FORMAT, AudioCapture, helperPath, listAudioDevices } from './audio-helper';
import { ENCODER_LABEL, describeProbe, muxArgs, probeCapture, recordArgs, type EncoderId, type ProbeResult } from './encoder';
import { TsReplayBuffer, type CaptureHandle } from './ts-buffer';
import type { BufferInfo, ClipRecorder, GameProcess, MicDevice, SavedVideo } from './types';

type Log = (msg: string, extra?: unknown) => void;

interface ActiveClip {
  fileName: string;
  folder: string;
  handle: CaptureHandle;
  onDone: (v: SavedVideo) => void;
  /** Lets the audio buffers drop this clip's audio again once it is saved. */
  releaseAudio: () => void;
}

/** start() was overtaken by stop() or a newer start(). Not a failure: nothing to report. */
export class StartCancelled extends Error {
  constructor() {
    super('Recorder start was cancelled');
    this.name = 'StartCancelled';
  }
}

export interface LocalRecorderOptions {
  /** Resolves the ffmpeg binary (the bundled one). */
  ffmpeg: () => Promise<string>;
}

export class LocalRecorder implements ClipRecorder {
  readonly kind = 'local' as const;
  info?: BufferInfo;
  probe?: ProbeResult;
  private ff?: ChildProcessWithoutNullStreams;
  private ffBin?: string;
  private ts = new TsReplayBuffer({ maxMs: 60_000 });
  private audio?: AudioCapture;
  private active?: ActiveClip;
  private stopping = false;
  private restarts = 0;
  private lastStart?: { settings: Settings; game: GameProcess; clipsFolder: string };
  private stderrTail: string[] = [];
  private saving = new Set<Promise<void>>();
  /** Bumped by every start() and stop(), so a start that is still probing knows it was overtaken. */
  private gen = 0;

  constructor(private log: Log, private opts: LocalRecorderOptions) {}

  get ffmpegPath(): string | undefined {
    return this.ffBin;
  }

  get clipInProgress(): boolean {
    return this.active !== undefined;
  }

  /** Mics as the audio helper sees them (Windows endpoint ids). */
  async listMics(): Promise<MicDevice[]> {
    const devices = await listAudioDevices();
    return devices?.capture ?? [];
  }

  async start(settings: Settings, game: GameProcess, clipsFolder: string): Promise<BufferInfo> {
    const gen = ++this.gen;
    // stop() (the game closed, the engine changed) or another start() can land during any await below.
    // Check after each one, and before spawning anything, so nothing is left running after a stop.
    const check = () => {
      if (gen !== this.gen) throw new StartCancelled();
    };
    await this.teardown();
    check();
    this.stopping = false;
    this.lastStart = { settings, game, clipsFolder };
    const ffmpeg = await this.opts.ffmpeg();
    check();
    this.ffBin = ffmpeg;

    const { localEncoder, captureMonitor } = localOptions(settings);
    const prefer: EncoderId | 'auto' = localEncoder;
    // After a crash, probe again: the screen resolution may have changed.
    const probe = await probeCapture(ffmpeg, captureMonitor, prefer, this.restarts > 0);
    check();
    this.probe = probe;
    if (!probe.ok || !probe.encoder) throw new Error(probe.problem ?? 'Screen capture is not available');
    this.log(`Local recorder: ${describeProbe(probe)}`, { adapters: probe.adapters, tried: probe.tried });
    if (probe.captureGpu && probe.captureGpu.vendor !== 'nvidia' && probe.adapters.some((a) => a.vendor === 'nvidia')) {
      this.log(
        `Your monitor is connected to ${probe.captureGpu.name}, not the GeForce. Plug the monitor into the graphics card for the best game performance; recording still works.`,
      );
    }

    const width = probe.width ?? 1920;
    const height = probe.height ?? 1080;
    const fps = settings.fps;
    const bufferMs = settings.bufferSeconds * 1000;
    // Audio is held a little longer than video; a clip being recorded also pins its own audio (startClip).
    const audioMs = bufferMs + 5000;
    // CPU encoding is capped at 1080p so it doesn't eat the game's frame time.
    const scaleHeight = probe.encoder.id === 'x264' ? Math.min(1080, height) : undefined;
    const outH = scaleHeight ?? height;
    const kbps = settings.bitrateKbps || defaultBitrate(outH, fps);

    this.ts = new TsReplayBuffer({ maxMs: bufferMs, frameTicks: Math.round(90000 / fps) });
    const args = recordArgs({ outputIdx: captureMonitor, fps, bitrateKbps: kbps, encoder: probe.encoder, scaleHeight, width, height });
    this.spawnFfmpeg(ffmpeg, args);

    // Audio: the game's own sound (or the whole desktop) and the mic, each on its own track.
    let micRecorded = false;
    const bin = helperPath();
    if (bin) {
      const audio = new AudioCapture(bin, audioMs);
      audio.on('status', (m: string) => this.log(m));
      audio.on('track', (name: string, st: { mode: string; device: string }) =>
        this.log(`${name === 'mic' ? 'Mic' : 'Game audio'} recording from ${st.mode === 'process' ? 'Marvel Rivals only' : st.device || st.mode}`),
      );
      audio.on('exit', (code: number) => this.log(`Audio capture stopped (code ${code}). Clips will be silent until the recorder restarts.`));
      audio.start({
        gamePid: settings.gameAudio === 'game-only' ? game.pid : undefined,
        desktopAudio: settings.gameAudio === 'desktop',
        mic: settings.recordMic ? settings.micDeviceId || 'default' : undefined,
        bufferMs: audioMs,
      });
      this.audio = audio;
      micRecorded = settings.recordMic;
    } else {
      this.log('Audio helper (rc-audio.exe) is missing, so local clips will have no sound. Reinstall Rivals Clipper to fix this.');
    }

    await this.waitForVideo(10_000, check);
    this.info = {
      width: scaleHeight ? Math.round((width * scaleHeight) / height / 2) * 2 : width,
      height: outH,
      fps,
      micRecorded,
      engine: 'local',
      encoder: ENCODER_LABEL[probe.encoder.id],
      gpu: probe.captureGpu?.name,
    };
    this.restarts = 0;
    return this.info;
  }

  async stop(): Promise<void> {
    this.gen++;
    await this.teardown();
  }

  private async teardown(): Promise<void> {
    this.stopping = true;
    if (this.active) this.stopClip();
    // Let a clip that is being saved finish before the buffers are torn down.
    await Promise.all([...this.saving]);
    const ff = this.ff;
    this.ff = undefined;
    if (ff && ff.exitCode === null) {
      // The stream lives in memory, so there is no file for ffmpeg to finish: just end it.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 3000);
        ff.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
        ff.kill();
      });
    }
    await this.audio?.stop();
    this.audio = undefined;
    this.ts.reset();
    this.info = undefined;
  }

  async startClip(fileName: string, pastDurationMs: number, onDone: (v: SavedVideo) => void): Promise<void> {
    if (this.active) return;
    if (!this.ff || !this.lastStart) throw new Error('Local recorder is not running');
    const handle = this.ts.beginCapture(pastDurationMs);
    // The audio rings only hold about the pre-roll. A clip can run for maxClipSeconds, so keep its audio
    // from the clip's first frame (less a second of slack) until it is saved.
    const from = (this.ts.captureStart(handle) ?? Date.now() - pastDurationMs) - 1000;
    const audio = this.audio;
    const releases = audio ? [audio.game.pin(from), audio.mic.pin(from)] : [];
    const releaseAudio = () => releases.forEach((r) => r());
    this.active = { fileName, folder: this.lastStart.clipsFolder, handle, onDone, releaseAudio };
  }

  stopClip(): void {
    const clip = this.active;
    if (!clip) return;
    this.active = undefined;
    const until = Date.now();
    const p = this.saveClip(clip, until).finally(() => this.saving.delete(p));
    this.saving.add(p);
  }

  // ---------- internals ----------

  private spawnFfmpeg(ffmpeg: string, args: string[]): void {
    const proc = spawn(ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.ff = proc;
    this.stderrTail = [];
    proc.stdout.on('data', (d: Buffer) => this.ts.push(d));
    proc.stderr.on('data', (d: Buffer) => {
      for (const line of d.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.stderrTail.push(line.trim());
        if (this.stderrTail.length > 30) this.stderrTail.shift();
      }
    });
    proc.on('exit', (code) => {
      if (this.ff !== proc) return;
      this.ff = undefined;
      if (this.stopping) return;
      const why = this.stderrTail.slice(-3).join(' | ');
      this.log(`Screen recorder stopped unexpectedly (code ${code})${why ? `: ${why}` : ''}`);
      // Save what we have of a clip in progress, then restart a few times (e.g. after a resolution change).
      if (this.active) this.stopClip();
      if (this.restarts++ < 5 && this.lastStart) {
        const { settings, game, clipsFolder } = this.lastStart;
        setTimeout(() => {
          if (this.stopping) return;
          this.start(settings, game, clipsFolder).catch((err) => {
            if (!(err instanceof StartCancelled)) this.log(`Recorder restart failed: ${(err as Error).message}`);
          });
        }, 2000 * this.restarts);
      }
    });
  }

  private waitForVideo(timeoutMs: number, check: () => void): Promise<void> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        try {
          check();
        } catch (err) {
          return reject(err);
        }
        if (this.ts.ready) return resolve();
        if (!this.ff) return reject(new Error(`ffmpeg exited: ${this.stderrTail.slice(-3).join(' | ') || 'no output'}`));
        if (Date.now() - started > timeoutMs) return reject(new Error('No video from the screen recorder after 10 seconds'));
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  private async saveClip(clip: ActiveClip, until: number): Promise<void> {
    try {
      await this.writeClip(clip, until);
    } finally {
      clip.releaseAudio();
    }
  }

  private async writeClip(clip: ActiveClip, until: number): Promise<void> {
    const result = this.ts.endCapture(clip.handle, until);
    if (!result) {
      clip.onDone({ duration: 0, startTimeEpoch: until, error: 'No video in the replay buffer yet' });
      return;
    }
    const { startEpoch, endEpoch } = result;
    // Audio arrives ~150 ms behind real time; wait until it covers the end of the video.
    const audio = this.audio;
    const deadline = Date.now() + 1500;
    while (audio && audio.running && Date.now() < deadline && (audio.game.endEpoch < endEpoch || (audio.tracks.mic && audio.mic.endEpoch < endEpoch))) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const tmp = path.join(clip.folder, '.recording');
    fs.mkdirSync(tmp, { recursive: true });
    const base = path.join(tmp, clip.fileName);
    const videoTs = `${base}.ts`;
    const out = path.join(clip.folder, `${clip.fileName}.mp4`);
    const temps = [videoTs];
    try {
      await fs.promises.writeFile(videoTs, result.data);
      const tracks: Array<{ file: string; label: 'game' | 'mic' }> = [];
      if (audio) {
        for (const label of ['game', 'mic'] as const) {
          const ring = label === 'game' ? audio.game : audio.mic;
          // A mic track is only written when the mic actually opened.
          if (label === 'mic' && !audio.tracks.mic) continue;
          if (label === 'game' && !audio.tracks.game && ring.endEpoch === 0) continue;
          const pcm = ring.extract(startEpoch, endEpoch);
          const file = `${base}.${label}.wav`;
          await fs.promises.writeFile(file, Buffer.concat([wavHeader(pcm.length, AUDIO_FORMAT), pcm]));
          temps.push(file);
          tracks.push({ file, label });
        }
      }
      // Keep the game track first even when only the mic exists, so track 1 is always game audio.
      if (tracks.length === 1 && tracks[0].label === 'mic') {
        const silent = `${base}.game.wav`;
        const frames = Math.round(((endEpoch - startEpoch) * AUDIO_FORMAT.sampleRate) / 1000);
        const bytes = frames * AUDIO_FORMAT.channels * 2;
        await fs.promises.writeFile(silent, Buffer.concat([wavHeader(bytes, AUDIO_FORMAT), Buffer.alloc(bytes)]));
        temps.push(silent);
        tracks.unshift({ file: silent, label: 'game' });
      }
      await execFfmpeg(this.ffBin ?? (await this.opts.ffmpeg()), muxArgs(videoTs, tracks, out));
      clip.onDone({ filePath: out, duration: Math.round(endEpoch - startEpoch), startTimeEpoch: Math.round(startEpoch), audioTracks: tracks.map((t) => t.label) });
    } catch (err) {
      clip.onDone({ duration: 0, startTimeEpoch: Math.round(startEpoch), error: (err as Error).message });
    } finally {
      for (const f of temps) fs.promises.unlink(f).catch(() => undefined);
    }
  }

  /** For the status panel: how much is buffered and how fast it is arriving. */
  stats() {
    return {
      videoSeconds: Math.round(this.ts.durationMs / 100) / 10,
      videoMB: Math.round(this.ts.bytesHeld / 1e5) / 10,
      gameAudio: this.audio?.tracks.game?.mode,
      mic: this.audio?.tracks.mic?.device,
    };
  }
}

function execFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 120_000 }, (err, _out, stderr) => {
      if (err) reject(new Error(String(stderr).trim().split(/\r?\n/).slice(-3).join(' | ') || err.message));
      else resolve();
    });
  });
}
