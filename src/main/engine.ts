// Which engine detects kills and records clips: Overwolf (game events + its recorder) or local
// (screen detection + the built-in ffmpeg recorder). Pure logic, so it is unit-tested.

export type EngineSetting = 'auto' | 'overwolf' | 'local';
export type Engine = 'overwolf' | 'local';

export interface OverwolfState {
  /** Running inside ow-electron at all. */
  present: boolean;
  /** Both the game-events and recorder packages loaded. */
  ready: boolean;
  /** A package failed, or they did not load in time. */
  failed: boolean;
}

/**
 * 'auto' uses Overwolf when its packages load and falls back to local mode when they can't
 * (an unsigned build, plain Electron). Undefined = still waiting to find out.
 */
export function chooseEngine(setting: EngineSetting, ow: OverwolfState): Engine | undefined {
  if (setting === 'local') return 'local';
  if (setting === 'overwolf') return ow.present ? 'overwolf' : 'local';
  if (ow.ready) return 'overwolf';
  if (!ow.present || ow.failed) return 'local';
  return undefined;
}

/**
 * How much more pre-roll a clip needs when the kill is reported late. Screen detection reports a kill
 * up to a second or two after it showed on screen, so the clip has to reach further back.
 */
export function lateBy(eventAt: number, now: number): number {
  const lag = now - eventAt;
  return lag > 0 && lag < 30_000 ? lag : 0;
}
