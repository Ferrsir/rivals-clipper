// A process can remain alive after display loss while emitting no encoded footage.
// Use a monotonic clock so adjusting Windows' wall clock cannot trigger recovery.
export class CaptureWatchdog {
  private timer?: NodeJS.Timeout;
  private lastProgress = 0;

  constructor(private onStall: () => void, private now = () => performance.now(), private timeoutMs = 15_000) {}

  start(): void {
    this.stop();
    this.progress();
    this.timer = setInterval(() => {
      if (this.now() - this.lastProgress < this.timeoutMs) return;
      this.stop();
      this.onStall();
    }, 2000);
    this.timer.unref();
  }

  progress(): void {
    this.lastProgress = this.now();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
