// Decides when a clip starts and when it ends, so a streak of kills lands in ONE clip.
// Pure logic with no timers or I/O, so it can be unit-tested. main.ts owns the timers.
//
// Two different "ends" matter:
// - endAt: where the saved footage stops (latest kill + postRoll), so clips stay tight.
// - stopAt: when we give up waiting for another kill (latest kill + chain window + detection lag).
// Screen detection reports a kill up to ~2 s after it happened, and kills in a streak can be
// 6+ s apart, so we keep the recorder open past endAt and trim the clip back to endAt on save.

export interface StreakConfig {
  /** How much footage before the first kill to keep (ms). */
  preRollMs: number;
  /** How much footage to keep after the latest kill (ms). */
  postRollMs: number;
  /** Hard cap on clip length so a long fight doesn't become a 5-minute file (ms). */
  maxClipMs: number;
  /** Kills at most this far apart join the same clip (ms). Defaults to postRollMs. */
  chainMs?: number;
  /** Extra wait for a kill that happened in time but is reported late (ms). Defaults to 0. */
  lateMs?: number;
}

export type StreakAction =
  | { type: 'start'; pastDurationMs: number; stopAt: number; endAt: number }
  | { type: 'extend'; stopAt: number; endAt: number }
  /** The kill is past the length cap: save the current clip (to its endAt) and start a new one. */
  | { type: 'restart' }
  | { type: 'none' };

/** Footage kept after a kill that lands in the grace window after your death. */
const KEEP_AFTER_KILL_MS = 700;

export class StreakTracker {
  private active = false;
  private clipStart = 0; // epoch ms the clip's footage begins
  private stopAt = 0;
  private endAt = 0;
  /** Set when you died during the clip: footage can't run past this. */
  private ceiling = Infinity;
  /** Time of the latest kill in the clip. */
  private lastKill = -Infinity;

  constructor(private cfg: StreakConfig) {}

  get isActive(): boolean {
    return this.active;
  }

  get currentStopAt(): number {
    return this.stopAt;
  }

  /** Where the current clip's footage should end. */
  get currentEndAt(): number {
    return this.endAt;
  }

  private get chainMs(): number {
    return Math.max(this.cfg.postRollMs, this.cfg.chainMs ?? this.cfg.postRollMs);
  }

  private get cap(): number {
    return Math.min(this.clipStart + this.cfg.maxClipMs, this.ceiling);
  }

  begin(now: number, pastMs: number, stopAt: number, endAt = stopAt): void {
    this.active = true;
    this.ceiling = Infinity;
    this.lastKill = now;
    this.clipStart = now - Math.min(pastMs, Math.max(0, this.cfg.maxClipMs - this.cfg.postRollMs));
    this.endAt = Math.min(endAt, this.cap);
    this.stopAt = Math.max(this.endAt, Math.min(stopAt, this.cap + (this.cfg.lateMs ?? 0)));
  }

  /** Call on every kill (or assist, if you want those to keep a clip alive). `now` is when it happened. */
  onKill(now: number): StreakAction {
    const late = this.cfg.lateMs ?? 0;
    if (!this.active) {
      this.begin(now, this.cfg.preRollMs, now + this.chainMs + late, now + this.cfg.postRollMs);
      return { type: 'start', pastDurationMs: now - this.clipStart, stopAt: this.stopAt, endAt: this.endAt };
    }
    // A kill the capped clip can't show: it gets its own clip instead of a marker past the footage.
    if (now > this.cap) return { type: 'restart' };
    this.lastKill = Math.max(this.lastKill, now);
    const endAt = Math.max(this.endAt, Math.min(now + this.cfg.postRollMs, this.cap));
    // Once the clip is full there is nothing left to wait for.
    const wait = endAt >= this.cap ? Math.max(this.stopAt, this.cap) : Math.max(this.stopAt, now + this.chainMs + late);
    // After a death there is only the short wait for late reports left.
    const stopAt = Math.min(wait, this.ceiling + late);
    if (endAt === this.endAt && stopAt === this.stopAt) return { type: 'none' };
    this.endAt = endAt;
    this.stopAt = stopAt;
    return { type: 'extend', stopAt, endAt };
  }

  /** The game called a multi-kill at `now`: keep waiting a full chain window for the next kill. */
  hold(now: number): number | undefined {
    if (!this.active || this.endAt >= this.cap) return undefined;
    const stopAt = Math.min(Math.max(this.stopAt, now + this.chainMs + (this.cfg.lateMs ?? 0)), this.ceiling + (this.cfg.lateMs ?? 0));
    if (stopAt <= this.stopAt) return undefined;
    this.stopAt = stopAt;
    return stopAt;
  }

  /**
   * You died at `at`: the footage ends `tailMs` later, and a kill can stretch it to at most `graceMs`
   * after the death (a projectile landing, or a kill the screen reported late). The recorder keeps
   * listening for those for `lateMs`. Returns the new stop time, or undefined when nothing changed.
   */
  cut(at: number, tailMs = 1000, graceMs = 2000): number | undefined {
    if (!this.active) return undefined;
    this.ceiling = Math.min(this.ceiling, Math.max(this.clipStart + 1, at + graceMs));
    // A kill already in the clip within the grace window stays in the footage, with a little after it.
    const keptKill = this.lastKill <= at + graceMs ? Math.min(this.lastKill + KEEP_AFTER_KILL_MS, this.ceiling) : -Infinity;
    const endAt = Math.min(this.endAt, Math.max(this.clipStart + 1, at + tailMs, keptKill));
    const stopAt = Math.max(endAt, Math.min(this.stopAt, this.ceiling + (this.cfg.lateMs ?? 0)));
    if (endAt === this.endAt && stopAt === this.stopAt) return undefined;
    this.endAt = endAt;
    this.stopAt = stopAt;
    return stopAt;
  }

  /** Call when the clip has actually been stopped (timer fired, match ended, or game closed). */
  finish(): void {
    this.ceiling = Infinity;
    this.lastKill = -Infinity;
    this.active = false;
    this.clipStart = 0;
    this.stopAt = 0;
    this.endAt = 0;
  }
}
