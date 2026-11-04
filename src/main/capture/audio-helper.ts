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

  constructor(private bin: string, bufferMs: number) {
    super();
    this.game = new PcmRing(AUDIO_FORMAT, bufferMs);
    this.mic = new PcmRing(AUDIO_FORMAT, bufferMs);
  }

  get running(): boolean {
    return !!this.proc && this.proc.exitCode === null;
  }

  start(opts: AudioCaptureOptions): void {
    if (this.proc) return;
    this.game.setMaxMs(opts.bufferMs);
    this.mic.setMaxMs(opts.bufferMs);
    const args = ['capture'];
    if (opts.desktopAudio || !opts.gamePid) args.push('--game-loopback');
    if (opts.gamePid) args.push('--game-pid', String(opts.gamePid));
    if (opts.mic) args.push('--mic', opts.mic);
    this.stopping = false;
    const proc = spawn(this.bin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
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
    proc.on('exit', (code) => {
      this.proc = undefined;
      if (!this.stopping) this.emit('exit', code);
    });
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.stopping = true;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        proc.kill();
        resolve();
      }, 2000);
      proc.once('exit', () => {
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
