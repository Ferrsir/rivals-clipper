// Types shared by the Studio's main-process code and its renderer (renderer/studio).
// The renderer is plain JS, so these are the documented shapes of what crosses IPC.

export type FormatId = 'tiktok' | 'reels' | 'shorts' | 'youtube' | 'youtube1440';

export interface ExportFormat {
  id: FormatId;
  label: string;
  platform: 'TikTok' | 'Instagram' | 'YouTube';
  width: number;
  height: number;
  fps: number;
  fpsOptions: number[];
  /** Length that performs best, in seconds. */
  idealSeconds: [number, number];
  /** Longest upload the platform accepts for this format. */
  maxSeconds: number;
  /** Fractions of the frame covered by the app's buttons and captions. Keep text out of these. */
  safe: { top: number; bottom: number; left: number; right: number };
  crf: number;
  maxrateKbps: number;
  audioKbps: number;
  music: {
    /** The platform has its own licensed sound library you can add in the app. */
    inAppLibrary: boolean;
    /** How likely an uploaded copyrighted song gets the video muted, claimed or blocked. */
    copyrightRisk: 'low' | 'medium' | 'high';
    note: string;
  };
}

// ---------- music ----------

export interface MusicAnalysis {
  version: 1;
  durationSec: number;
  bpm: number;
  /** Beat times in seconds. */
  beats: number[];
  /** Times (seconds) of the first beat of each bar. */
  downbeats: number[];
  /** Loudness around each beat, 0..1, same length as beats. */
  beatEnergy: number[];
  /** Drop times in seconds, strongest first. */
  drops: number[];
  /** Overall energy of the track, 0..1. */
  energy: number;
  /** How regular the beat grid is, 0..1. */
  confidence: number;
  /** Waveform peaks for drawing, 0..1. */
  peaks: number[];
}

/**
 * own: you made it or bought a licence. royalty-free: YouTube Audio Library, NCS, StreamBeats and similar.
 * platform-only: fine inside TikTok/Instagram's own sound picker, risky as an uploaded file.
 */
export type MusicLicense = 'own' | 'royalty-free' | 'platform-only' | 'unknown';

export interface MusicTrack {
  id: string;
  file: string;
  title: string;
  artist?: string;
  addedAt: number;
  license: MusicLicense;
  tags: string[];
  analysis?: MusicAnalysis;
  analysisError?: string;
  lastUsedAt?: number;
  /** Attribution the licence asks for, e.g. "Song" by Artist (CC BY 4.0) via Jamendo. Put it in the post caption. */
  credit?: string;
  /** Where the file came from, when it was downloaded through the Studio. */
  sourceUrl?: string;
}

export interface MusicSuggestion {
  trackId: string;
  score: number;
  /** Where in the track the reel should start, seconds. */
  suggestedStart: number;
  reasons: string[];
  warnings: string[];
}

export interface MusicSource {
  name: string;
  url: string;
  why: string;
  /** Safe to upload on YouTube without a claim. */
  youtubeSafe: boolean;
}

export interface AiMusicIdea {
  title: string;
  artist?: string;
  genre?: string;
  why: string;
  where: string;
  search: string;
}

// ---------- edit styles ----------

export type BeatPulse = 'none' | 'downbeats' | 'all';

export interface StyleRecipe {
  id: string;
  name: string;
  description: string;
  /** Snap kills and cuts to the music's beats. */
  beatSync: boolean;
  /** Slowest and fastest playback used to land kills on beats. [1, 1] never changes speed. */
  speedRange: [number, number];
  /** Preferred speed for the run-up and the gaps between kills. Velocity edits run above 1. */
  cruiseSpeed: number;
  /** Output seconds from the start of a clip to its first kill. */
  leadIn: [number, number];
  /** Output seconds after the last kill's slow-mo before cutting to the next clip. */
  tail: [number, number];
  slowmo: {
    on: boolean;
    speed: number;
    /** Source seconds slowed before and after each kill. */
    before: number;
    after: number;
    /** Frame blending makes slow-mo smoother. 'motion' is smoothest and slowest to export. */
    smooth: 'none' | 'blend' | 'motion';
    /** Game volume during slow-mo, as a fraction of normal. */
    gameVolume: number;
    /** Slow every kill, or only the hero clip's kills (the big moment). */
    scope: 'all' | 'hero';
  };
  zoom: { on: boolean; amount: number; attack: number; release: number; onBeats: BeatPulse; beatAmount: number };
  shake: { on: boolean; amount: number; duration: number; frequency: number; onBeats: BeatPulse; beatAmount: number };
  flash: { on: boolean; strength: number; duration: number; onKills: boolean; onDrop: boolean; onCuts: boolean };
  rgbSplit: { on: boolean; amount: number; duration: number };
  /** Blend frames on sped-up parts so they smear like a real velocity edit. */
  motionBlur: { on: boolean; minSpeed: number };
  grade: { contrast: number; saturation: number; brightness: number; gamma: number; vignette: number; sharpen: number };
  /** Afterimage trails ("Sandevistan"). onSlowmo: only during kill slow-mo. */
  echo: { on: boolean; strength: number; onSlowmo: boolean };
  transition: 'cut' | 'flash' | 'dip' | 'whip';
  /** Seconds of fade to black at the end. */
  fadeOut: number;
  captions: CaptionStyle;
  /** Short synthesized hit sound on each kill. 0 = off. */
  impactSound: number;
  /** Default mix for projects that pick this style. */
  mix: Mix;
}

export interface CaptionStyle {
  /** Where caption lines sit. They always stay inside the format's safe area. */
  position: 'top' | 'middle' | 'bottom';
  /** Text height as a fraction of the frame width. */
  size: number;
  uppercase: boolean;
  /** Beats each auto-timed line stays up. */
  beatsPerLine: number;
}

export interface Mix {
  game: number;
  mic: number;
  music: number;
  /** Lower the music while you talk. */
  duck: boolean;
}

// ---------- projects ----------

export interface ReelClip {
  /** Unique within the project (the same clip can appear twice). */
  uid: string;
  clipId: string;
  videoFile: string;
  hero?: string;
  map?: string;
  kills: number;
  score: number;
  tags: string[];
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasMic: boolean;
  /** Kill moments inside the clip, seconds. You can nudge or add these. */
  hits: number[];
  /** Usable part of the clip, seconds. */
  in: number;
  out: number;
  /** Mix this clip's mic track (track 2) into the reel. */
  useMic: boolean;
  /** Mute this clip's game audio. */
  muteGame?: boolean;
  /** Horizontal centre of the vertical crop, 0 = left edge, 1 = right edge. */
  cropX: number;
  /** Vertical centre of the crop, used when cropZoom > 1. */
  cropY: number;
  /** 1 = full height. Higher punches in. */
  cropZoom: number;
}

export interface ReelMusic {
  trackId: string;
  file: string;
  title: string;
  /** Seconds into the track where the reel starts. 'auto' lets the planner pick so the best kill lands on the drop. */
  start: number | 'auto';
}

export interface ReelProject {
  version: 1;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  format: FormatId;
  fps: number;
  style: StyleRecipe;
  clips: ReelClip[];
  music: ReelMusic | null;
  mix: Mix;
  /** manual: your order. build-up: weakest first so the best play hits the drop at the end. */
  order: 'manual' | 'build-up';
  /** uid of the clip whose first kill should land on the drop. Default: the highest score. */
  heroUid?: string;
  /** Story or lyric lines shown over the reel. */
  captions: CaptionLine[];
  /** Optional hook card before the first clip: an image and a big line of text. */
  intro: IntroCard | null;
  /** Optional end text over the last seconds, e.g. "Follow for part 2". */
  outro?: OutroText | null;
  /** Post caption and hashtags for the upload. */
  caption?: string;
  lastExports?: Array<{ file: string; format: FormatId; at: number }>;
}

export interface OutroText {
  text: string;
  seconds: number;
}

export interface CaptionLine {
  text: string;
  /** Output seconds. Leave both out to spread lines over the beats automatically. */
  start?: number;
  end?: number;
}

export interface IntroCard {
  /** Image file (png/jpg/webp). Without one, the first frame of the first clip is used. */
  image?: string;
  /**
   * The hook. Several lines (one per line) play one after another, like a short dialogue
   * ("WHO'S STRONGER?" / "HIM?" / "OR YOU?").
   */
  text: string;
  seconds: number;
  /** band: the picture in a strip across the middle over a blurred copy of itself, text under it (the reference look). full: the picture fills the screen. */
  layout?: 'band' | 'full';
  /** Attribution for a downloaded Creative Commons picture. */
  imageCredit?: string;
}

// ---------- the planned edit ----------

export type SegmentKind = 'intro' | 'lead' | 'slow-in' | 'slow-out' | 'gap' | 'tail' | 'plain';

export interface TimelineSegment {
  clipUid: string;
  clipIndex: number;
  kind: SegmentKind;
  /** Source seconds inside the clip. */
  src: [number, number];
  /** Output seconds, on the frame grid. */
  out: [number, number];
  speed: number;
}

export interface TimelineClip {
  uid: string;
  index: number;
  out: [number, number];
  /** Output times of this clip's kills. */
  kills: number[];
  /** Per kill: whether it landed on a beat. */
  onBeat: boolean[];
}

export interface Timeline {
  fps: number;
  duration: number;
  segments: TimelineSegment[];
  clips: TimelineClip[];
  /** Output times. */
  kills: number[];
  cuts: number[];
  beats: number[];
  downbeats: number[];
  drop?: number;
  /** Output time where the intro card ends and the first clip starts (0 without an intro). */
  introEnd: number;
  /** Caption lines with resolved output times. */
  captions: Array<{ text: string; start: number; end: number }>;
  /** Seconds into the music track at output time 0. */
  musicStart: number;
  /** The track ends before the reel does. */
  musicShort: boolean;
  warnings: string[];
}

// ---------- rendering ----------

export interface RenderRequest {
  preview: boolean;
  formats: FormatId[];
  /** Also save a copy without music, to add the same song inside TikTok/Instagram. */
  noMusicCopy: boolean;
  /** Use the graphics card's encoder when one is available. */
  gpu: boolean;
}

export interface RenderProgress {
  jobId: string;
  stage: 'clips' | 'assemble' | 'done' | 'error' | 'cancelled';
  pct: number;
  message: string;
  files?: string[];
  error?: string;
}

// ---------- free media (Openverse: Creative Commons and public domain) ----------

export interface FreeMedia {
  id: string;
  kind: 'audio' | 'image';
  title: string;
  creator?: string;
  /** cc0, pdm, by, by-sa: all allow commercial use and editing. */
  license: string;
  licenseVersion?: string;
  licenseUrl?: string;
  /** Page to credit and to check the licence on. */
  landingUrl?: string;
  /** Direct file URL. */
  url: string;
  thumbnail?: string;
  provider?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  /** Ready-to-paste attribution. Empty for public domain. */
  credit: string;
  needsCredit: boolean;
}

// ---------- reel ideas ----------

export interface ReelIdea {
  id: string;
  title: string;
  /** One sentence: what the edit is about. */
  concept: string;
  /** Hook card text: one line, or up to 4 short lines shown one after another. Empty for no hook card. */
  hook: string;
  /** Big text over the last seconds, e.g. "Comment who wins". */
  endText?: string;
  /** What the hook card picture should show, and words to search for one. */
  imageIdea: string;
  imageSearch: string;
  captions: string[];
  styleId: string;
  format: FormatId;
  /** Library clip ids in reel order. */
  clipIds: string[];
  music: {
    /** A song already in your library, if one fits. */
    trackId?: string;
    mood: string;
    bpm?: [number, number];
    /** Words to search royalty-free music with. */
    search: string;
  };
  postCaption?: string;
  /** Why this would do well. */
  why: string;
  source: 'ai' | 'quick';
}

// ---------- publishing ----------

export type PublishPlatform = 'youtube' | 'tiktok' | 'instagram';

export interface PublishStatus {
  platform: PublishPlatform;
  label: string;
  /** Your developer app's keys are saved. */
  configured: boolean;
  /** Signed in and ready to upload. */
  connected: boolean;
  account?: string;
  /** What uploading does on this platform, in plain words. */
  note: string;
  /** Where to create the developer app. */
  setupUrl: string;
  /** The platform's own upload page, for posting by hand. */
  uploadPageUrl: string;
  /** Labels for the key fields this platform needs. */
  fields: Array<{ key: 'clientId' | 'clientSecret'; label: string }>;
  /** The redirect address to register in the developer app. */
  redirectUri?: string;
  tiktokMode?: 'inbox' | 'direct';
}

export interface PublishRequest {
  platform: PublishPlatform;
  file: string;
  title: string;
  description: string;
  tags: string[];
  privacy: 'public' | 'unlisted' | 'private';
  shorts?: boolean;
}

export interface PublishProgress {
  uploadId: string;
  platform: PublishPlatform;
  stage: 'uploading' | 'processing' | 'done' | 'error';
  pct: number;
  message: string;
  url?: string;
  error?: string;
}

export interface StudioInit {
  formats: ExportFormat[];
  styles: StyleRecipe[];
  paths: { root: string; studio: string; music: string; reels: string };
  ffmpeg: { ok: boolean; path?: string; version?: string; gpuEncoders: string[]; problem?: string };
  ai: { signedIn: boolean; provider: string };
}
