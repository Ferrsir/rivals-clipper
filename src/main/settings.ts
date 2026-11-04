// User settings, stored as JSON in the clips root so they travel with the library.
// Default root is F:\RivalsClips as Ferris asked.

import fs from 'node:fs';
import path from 'node:path';

export interface Settings {
  /** Everything lives under here: clips, logs, settings. */
  rootFolder: string;
  /** Seconds the replay buffer keeps in memory. Must be >= preRoll + a bit. */
  bufferSeconds: number;
  preRollSeconds: number;
  postRollSeconds: number;
  maxClipSeconds: number;
  /** 'native' = your monitor's resolution, which is what Marvel Rivals renders at. */
  resolution: 'native' | '1080p' | '1440p' | '2160p';
  fps: 60 | 120;
  /** Video bitrate in kbps. 0 = pick from resolution. */
  bitrateKbps: number;
  /** Record your mic onto its own track (track 2). The game track never contains the mic. */
  recordMic: boolean;
  /** Mic device id from the recorder's device list, or 'default'. */
  micDeviceId: string;
  /** 'game-only' records only Marvel Rivals' sound (no Discord/Spotify). 'desktop' records everything you hear. */
  gameAudio: 'game-only' | 'desktop';
  /** New clips start with their mic track switched on for reels. You can flip it per clip. */
  useMicInReelsByDefault: boolean;
  manualClipHotkey: string;
  /** Also count assists as keeping a streak clip alive. */
  assistsExtendClip: boolean;
  /** Auto-clip kills in the Practice Range too. Off by default; the manual hotkey always works. */
  clipPractice: boolean;
  /** Which AI you signed in with. 'none' = skipped the sign-in screen. */
  aiProvider: 'claude' | 'codex' | 'none';
  /** Set once the first-launch sign-in screen has been completed or skipped. */
  onboarded: boolean;
  /**
   * How kills are detected and clips recorded.
   * 'local': screen detection + the built-in recorder (no Overwolf). 'overwolf': Overwolf's game events and recorder.
   * 'auto': Overwolf when its packages load, otherwise local.
   */
  engine: 'auto' | 'overwolf' | 'local';
  /** Local recorder: which monitor to record, counted on the graphics card that drives the main monitor (0 = main). */
  captureMonitor: number;
  /** Local recorder: video encoder. 'auto' picks the one on the card your monitor is plugged into. */
  localEncoder: 'auto' | 'nvenc' | 'amf' | 'qsv' | 'x264';
  /** Your in-game name, so the kill feed can tell your kills from your deaths. Empty = learn it from the feed. */
  playerName: string;
  /** In-game HUD scale (1 = default). */
  hudScale: number;
  /** Screen detection checks this many frames per second. */
  detectionFps: number;
  /** Read names, streak counts, map and match result from the screen (text recognition). */
  readScreenText: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  rootFolder: 'F:\\RivalsClips',
  bufferSeconds: 60,
  preRollSeconds: 12,
  postRollSeconds: 5,
  maxClipSeconds: 90,
  resolution: 'native',
  fps: 60,
  bitrateKbps: 0,
  recordMic: true,
  micDeviceId: 'default',
  gameAudio: 'game-only',
  useMicInReelsByDefault: false,
  manualClipHotkey: 'F9',
  assistsExtendClip: false,
  clipPractice: false,
  aiProvider: 'none',
  onboarded: false,
  engine: 'auto',
  captureMonitor: 0,
  localEncoder: 'auto',
  playerName: '',
  hudScale: 1,
  detectionFps: 10,
  readScreenText: true,
};

export const paths = (root: string) => ({
  root,
  clips: path.join(root, 'clips'),
  logs: path.join(root, 'logs'),
  exports: path.join(root, 'exports'),
  reels: path.join(root, 'exports', 'reels'),
  studio: path.join(root, 'studio'),
  music: path.join(root, 'music'),
  settings: path.join(root, 'settings.json'),
  heroRoles: path.join(root, 'hero-roles.json'),
});

export function loadSettings(root = DEFAULT_SETTINGS.rootFolder): Settings {
  const p = paths(root);
  try {
    const raw = JSON.parse(fs.readFileSync(p.settings, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS, rootFolder: root };
  }
}

export function saveSettings(s: Settings): void {
  const p = paths(s.rootFolder);
  fs.mkdirSync(p.root, { recursive: true });
  fs.writeFileSync(p.settings, JSON.stringify(s, null, 2));
}

export function ensureFolders(root: string): void {
  const p = paths(root);
  for (const dir of [p.root, p.clips, p.logs, p.exports, p.reels, p.studio, p.music]) fs.mkdirSync(dir, { recursive: true });
}

/** Bitrate that keeps enough detail for a 9:16 crop and re-encode later. */
export function defaultBitrate(height: number, fps: number): number {
  const base = height >= 2160 ? 60000 : height >= 1440 ? 35000 : 20000;
  return fps > 60 ? Math.round(base * 1.5) : base;
}

export function resolveResolution(setting: Settings['resolution'], native: { width: number; height: number }) {
  if (setting === 'native') return native;
  const h = setting === '1080p' ? 1080 : setting === '1440p' ? 1440 : 2160;
  const aspect = native.width / native.height || 16 / 9;
  return { width: Math.round((h * aspect) / 2) * 2, height: h };
}

/** Local-mode settings with bad values (an empty box, a hand-edited file) replaced by safe ones. */
export function localOptions(s: Partial<Settings>) {
  const num = (v: unknown, min: number, max: number, fallback: number) => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const encoders = ['auto', 'nvenc', 'amf', 'qsv', 'x264'] as const;
  return {
    engine: (['auto', 'overwolf', 'local'] as const).includes(s.engine as never) ? (s.engine as Settings['engine']) : 'auto',
    captureMonitor: Math.round(num(s.captureMonitor, 0, 7, 0)),
    localEncoder: encoders.includes(s.localEncoder as never) ? (s.localEncoder as Settings['localEncoder']) : 'auto',
    playerName: typeof s.playerName === 'string' ? s.playerName.trim().slice(0, 40) : '',
    hudScale: Math.round(num(s.hudScale, 0.5, 1.5, 1) * 100) / 100,
    detectionFps: Math.round(num(s.detectionFps, 4, 20, 10)),
    readScreenText: typeof s.readScreenText === 'boolean' ? s.readScreenText : true,
  };
}
