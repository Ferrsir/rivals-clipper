// Decides when a clip starts and when it ends, so a streak of kills lands in ONE clip.
// Pure logic with no timers or I/O, so it can be unit-tested. main.ts owns the timers.

export interface StreakConfig {
  /** How much footage before the first kill to keep (ms). */
  preRollMs: number;
  /** How long to keep recording after the latest kill, waiting for another one (ms). */
  postRollMs: number;
  /** Hard cap on clip length so a long fight doesn't become a 5-minute file (ms). */
  maxClipMs: number;
}

export type StreakAction =
  | { type: 'start'; pastDurationMs: number; stopAt: number }
  | { type: 'extend'; stopAt: number }
  | { type: 'none' };

export class StreakTracker {
  private active = false;
  private clipStart = 0; // epoch ms the clip's footage begins
  private stopAt = 0;

  constructor(private cfg: StreakConfig) {}

  get isActive(): boolean {
    return this.active;
  }

  get currentStopAt(): number {
    return this.stopAt;
  }

  begin(now: number, pastMs: number, stopAt: number): void {
    this.active = true;
    this.clipStart = now - Math.min(pastMs, Math.max(0, this.cfg.maxClipMs - this.cfg.postRollMs));
    this.stopAt = Math.min(stopAt, this.clipStart + this.cfg.maxClipMs);
  }

  /** Call on every kill (or assist, if you want those to keep a clip alive). */
  onKill(now: number): StreakAction {
    if (!this.active) {
      this.begin(now, this.cfg.preRollMs, now + this.cfg.postRollMs);
      return { type: 'start', pastDurationMs: now - this.clipStart, stopAt: this.stopAt };
    }
    const next = Math.min(now + this.cfg.postRollMs, this.clipStart + this.cfg.maxClipMs);
    if (next > this.stopAt) {
      this.stopAt = next;
      return { type: 'extend', stopAt: this.stopAt };
    }
    return { type: 'none' };
  }

  /** Call when the clip has actually been stopped (timer fired, match ended, or game closed). */
  finish(): void {
    this.active = false;
    this.clipStart = 0;
    this.stopAt = 0;
  }
}
