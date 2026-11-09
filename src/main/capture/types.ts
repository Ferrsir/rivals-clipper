// What main.ts needs from a recorder, so the Overwolf recorder and the local (ffmpeg) recorder
// are interchangeable. Both produce the same clip files: H.264 MP4, game audio on track 1, mic on track 2.

import type { Settings } from '../settings';

export interface GameProcess {
  pid?: number;
  fullPath?: string;
}

export interface BufferInfo {
  width: number;
  height: number;
  fps: number;
  micRecorded: boolean;
  /** Which recorder and encoder are in use, for the status line. */
  engine?: 'overwolf' | 'local';
  encoder?: string;
  gpu?: string;
}

export interface SavedVideo {
  filePath?: string;
  /** Length in ms. */
  duration: number;
  /** Epoch ms of the first frame. */
  startTimeEpoch: number;
  error?: unknown;
  /** Raw video/audio retained after a failed conversion, so the footage can be recovered. */
  recoveryFolder?: string;
  /** Audio tracks actually inside the file. Overwolf clips leave this out (main.ts uses BufferInfo.micRecorded). */
  audioTracks?: Array<'game' | 'mic'>;
}

export interface MicDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface ClipRecorder {
  readonly kind: 'overwolf' | 'local';
  info?: BufferInfo;
  /** An ffmpeg binary the export code can use. */
  readonly ffmpegPath?: string;
  start(settings: Settings, game: GameProcess, clipsFolder: string): Promise<BufferInfo>;
  stop(): Promise<void>;
  /** Start saving a clip that includes the last `pastDurationMs`. Keeps recording until stopClip(). */
  startClip(fileName: string, pastDurationMs: number, onDone: (video: SavedVideo) => void): Promise<void>;
  /** Stop the clip. `untilEpoch` trims footage after that time (the streak's end), when the recorder can. */
  stopClip(untilEpoch?: number): void;
  readonly clipInProgress: boolean;
  listMics(): Promise<MicDevice[]>;
}
