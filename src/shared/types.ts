// Types shared by the main process, the clip sidecar files and the UI.

export type HeroRole = 'Vanguard' | 'Duelist' | 'Strategist' | 'Unknown';

/** One kill, assist or death that happened inside a clip. */
export interface ClipEvent {
  type: 'kill' | 'assist' | 'death';
  /** Epoch ms when GEP reported it. */
  at: number;
  /** Your running total for this match, as GEP reports it. */
  total?: number;
  victim?: string;
  victimHero?: string;
  victimRole?: HeroRole;
  /** Hero you were playing at the time. */
  myHero?: string;
  /** Teammates still alive (including you) at the moment of the kill. */
  teammatesAlive?: number;
  /** Enemies still alive after the kill. */
  enemiesAlive?: number;
}

export interface MatchContext {
  matchId?: string;
  gameType?: string; // Practice, Quick match, Competitive, Arcade
  gameMode?: string;
  map?: string;
  round?: number;
  outcome?: 'Victory' | 'Defeat' | 'Draw';
}

/** Written next to every clip as <clip>.json. The Library and Reel Maker read this. */
export interface ClipSidecar {
  version: 1;
  id: string;
  videoFile: string;
  createdAt: number;
  /** Epoch ms of the clip's first frame. */
  startTimeEpoch: number;
  durationMs: number;
  trigger: 'auto' | 'manual';
  hero?: string;
  match: MatchContext;
  events: ClipEvent[];
  /** Your ult went from full to used within a few seconds of the first kill. */
  ultUsedBeforeKills: boolean;
  /** Match ended (with this outcome) shortly after the clip. Filled in at match end. */
  endedMatch?: 'Victory' | 'Defeat' | 'Draw';
  video: { width: number; height: number; fps: number };
  /** Audio track layout inside the MP4. Track 1 is always game audio. */
  audioTracks: Array<{ index: number; label: 'game' | 'mic' }>;
  /** Whether the mic track should be used when this clip goes into a reel. You can flip it per clip. */
  useMic: boolean;
  score: number;
  tags: string[];
  scoreBreakdown: Record<string, number>;
  /** Your 1–5 star rating, if you've given one. */
  rating?: number;
  /** What your signed-in AI saw in a few frames of the clip. Optional; added after the clip is saved. */
  ai?: ClipAiInfo;
}

export interface ClipAiInfo {
  /** Player hero visually identified from the player HUD, only when clear. */
  hero?: string;
  /** Play-style tags such as "flank", "dive", "ult-combo", lowercase with dashes. */
  tags: string[];
  /** One short line describing the play. */
  summary: string;
  /** 1 (nothing special) to 10 (incredible). */
  hype: number;
  provider: 'claude' | 'codex';
  /** Epoch ms when tagged. */
  at: number;
  /** Set when tagging failed; tags/summary are then empty. */
  error?: string;
}
