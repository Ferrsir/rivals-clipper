// One cancellable retry timer for the current game session. The main process owns capture startup.
export class CaptureRecovery {
  private timer?: NodeJS.Timeout;
  private failures = 0;

  /** A manual restart supersedes a pending retry without losing failure backoff. */
  clearPending(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Game closed, app quit, engine changed, or recording recovered. */
  reset(): void {
    this.clearPending();
    this.failures = 0;
  }

  /** Returns the delay for the status message. Repeated failures settle at one try every 30 seconds. */
  schedule(retry: () => void): number {
    this.clearPending();
    const delay = Math.min(30_000, 2000 * 2 ** Math.min(4, this.failures++));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      retry();
    }, delay);
    return delay;
  }
}
