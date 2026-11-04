// Runs rc-audio.exe (native/rc-audio), which captures Marvel Rivals' own sound and your mic as
// timestamped PCM. The chunks go into two rolling buffers that the local recorder cuts clips from.

import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { AudioChunkParser, PcmRing } from './audio-buffer';
import type { MicDevice } from './types';

export const AUDIO_FORMAT = { sampleRate: 48000, channels: 2 };

export interface AudioDevices {
  capture: MicDevice[];
  render: MicDevice[];
  processLoopback: boolean;
}

export interface TrackStatus {
  mode: 'process' | 'loopback' | 'mic';
  device: string;
}

/** Where rc-audio.exe lives: next to the app when installed, native/bin when running from source. */
export function helperPath(): string | undefined {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const list = [
    process.env.RC_AUDIO_PATH,
    resources && path.join(resources, 'native', 'rc-audio.exe'),
    path.join(__dirname, '..', '..', '..', 'native', 'bin', 'rc-audio.exe'),
  ].filter((p): p is string => !!p);
  return list.find((p) => fs.existsSync(p));
}

export function listAudioDevices(bin = helperPath()): Promise<AudioDevices | undefined> {
  if (!bin) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(bin, ['list'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(undefined);
      try {
        resolve(JSON.parse(String(stdout)) as AudioDevices);
      } catch {
        resolve(undefined);
      }
    });
  });
}

export interface AudioCaptureOptions {
  gamePid?: number;
  /** Record everything on the default speakers instead of just the game. */
  desktopAudio?: boolean;
  /** Mic device id, 'default', or undefined for no mic. */
  mic?: string;
  bufferMs: number;
}

type SpawnAudio = (bin: string, args: string[]) => ChildProcessWithoutNullStreams;

/** Desktop sound is opt-in; a missing game PID must never widen the capture source. */
export function audioCaptureArgs(opts: AudioCaptureOptions): string[] {
  const args = ['capture'];
  if (opts.desktopAudio) args.push('--game-loopback');
  else if (Number.isInteger(opts.gamePid) && opts.gamePid! > 0) args.push('--game-pid', String(opts.gamePid));
  else args.push('--no-game');
  if (opts.mic) args.push('--mic', opts.mic);
  return args;
}

/**
 * Events: 'status' (message: string), 'track' (track: 'game' | 'mic', status: TrackStatus), 'exit' (code).
 */
export class AudioCapture extends EventEmitter {
  readonly game: PcmRing;
  readonly mic: PcmRing;
  readonly tracks: { game?: TrackStatus; mic?: TrackStatus } = {};
  private proc?: ChildProcessWithoutNullStreams;
  private parser = new AudioChunkParser();
  private stopping = false;
  private restartTimer?: NodeJS.Timeout;
  private retries = 0;
  private opts?: AudioCaptureOptions;

  constructor(private bin: string, bufferMs: number, private spawnAudio: SpawnAudio = (bin, args) =>
    spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })) {
    super();
    this.game = new PcmRing(AUDIO_FORMAT, bufferMs);
    this.mic = new PcmRing(AUDIO_FORMAT, bufferMs);
  }

  get running(): boolean {
    return !!this.proc && this.proc.exitCode === null;
  }

  start(opts: AudioCaptureOptions): void {
    if (this.proc || this.restartTimer) return;
    this.opts = { ...opts };
    this.retries = 0;
    this.stopping = false;
    this.launch();
  }

  private launch(): void {
    if (this.stopping || !this.opts) return;
    const opts = this.opts;
    this.game.setMaxMs(opts.bufferMs);
    this.mic.setMaxMs(opts.bufferMs);
    const args = audioCaptureArgs(opts);
    if (!opts.desktopAudio && args.includes('--no-game')) this.emit('status', 'Game audio is off because no valid game process was found. Desktop sound is not being recorded.');
    const proc = this.spawnAudio(this.bin, args);
    const startedAt = Date.now();
    this.proc = proc;
    // An incomplete message from the previous process cannot prefix the new wire stream.
    this.parser = new AudioChunkParser();
    proc.stdin.on('error', () => undefined); // shutdown can race a helper that has already exited
    proc.stdout.on('data', (d: Buffer) =>
      this.parser.push(d, (c) => {
        const ring = c.track === 1 ? this.mic : this.game;
        if (c.sampleRate === AUDIO_FORMAT.sampleRate && c.channels === AUDIO_FORMAT.channels) ring.push(c.epochMs, c.pcm);
      }),
    );
    let errBuf = '';
    proc.stderr.on('data', (d: Buffer) => {
      errBuf += d.toString('utf8');
      let nl: number;
      while ((nl = errBuf.indexOf('\n')) >= 0) {
        this.onStatusLine(errBuf.slice(0, nl).trim());
        errBuf = errBuf.slice(nl + 1);
      }
    });
    proc.on('error', (err) => this.emit('status', `Audio capture failed to start: ${err.message}`));
    // close waits for stdout to drain, preserving the last audio chunks before recovery.
    proc.on('close', (code) => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      delete this.tracks.game;
      delete this.tracks.mic;
      if (this.stopping) return;
      this.emit('exit', code);
      if (Date.now() - startedAt >= 30_000) this.retries = 0;
      if (this.retries >= 5) {
        this.emit('status', 'Audio capture could not recover after five attempts. Restart recording in Settings.');
        return;
      }
      const delay = Math.min(30_000, 2000 * 2 ** this.retries++);
      this.emit('status', `Audio capture interrupted. Retrying in ${delay / 1000} seconds (${this.retries}/5).`);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        this.launch();
      }, delay);
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const proc = this.proc;
    if (proc) await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        proc.kill();
        resolve();
      }, 2000);
      proc.once('close', () => {
        clearTimeout(t);
        resolve();
      });
      try {
        proc.stdin.write('q');
        proc.stdin.end();
      } catch {
        proc.kill();
      }
    });
    this.proc = undefined;
    this.game.clear();
    this.mic.clear();
    delete this.tracks.game;
    delete this.tracks.mic;
  }

  private onStatusLine(line: string): void {
    if (!line) return;
    let msg: { event?: string; track?: number; mode?: TrackStatus['mode']; device?: string; message?: string; hr?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const name = msg.track === 1 ? 'mic' : 'game';
    if (msg.event === 'started' && msg.mode) {
      this.tracks[name] = { mode: msg.mode, device: msg.device ?? '' };
      this.emit('track', name, this.tracks[name]);
    } else if (msg.event === 'error' || msg.event === 'notice' || msg.event === 'track-failed') {
      this.emit('status', `${name === 'mic' ? 'Mic' : 'Game audio'}: ${msg.message ?? msg.event}${msg.hr ? ` (${msg.hr})` : ''}`);
    }
  }
}
