// Appends every raw GEP event and info update to a daily JSONL file,
// so we can see exactly what Marvel Rivals reports and when.
// Lines are buffered and written about once a second off the main thread, so logging never
// stalls the app mid-match. Files older than `keepDays` are deleted on startup.

import fs from 'node:fs';
import path from 'node:path';

export class EventLog {
  private lines = new Map<string, string[]>();
  private timer: NodeJS.Timeout | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private folder: string,
    private opts: { keepDays?: number; flushMs?: number; now?: () => Date } = {},
  ) {
    this.prune();
  }

  private get now() {
    return this.opts.now?.() ?? new Date();
  }

  write(kind: string, data: unknown): void {
    const now = this.now;
    let line: string;
    try {
      line = JSON.stringify({ t: now.getTime(), iso: now.toISOString(), kind, data }) + '\n';
    } catch {
      return; // unserialisable data: skip rather than break clipping
    }
    const file = path.join(this.folder, `gep-${now.toISOString().slice(0, 10)}.jsonl`);
    const list = this.lines.get(file) ?? [];
    list.push(line);
    this.lines.set(file, list);
    this.timer ??= setTimeout(() => void this.flush(), this.opts.flushMs ?? 1000);
  }

  /** Write everything buffered so far. Safe to call any time, e.g. on quit. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.lines;
    this.lines = new Map();
    this.writing = this.writing.then(async () => {
      for (const [file, list] of batch) {
        await fs.promises.appendFile(file, list.join('')).catch(() => undefined); // never let logging break clipping
      }
    });
    return this.writing;
  }

  /** Synchronous flush for app exit, when async work may not finish. */
  flushSync(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const [file, list] of this.lines) {
      try {
        fs.appendFileSync(file, list.join(''));
      } catch {
        /* ignore */
      }
    }
    this.lines = new Map();
  }

  /** Delete gep-YYYY-MM-DD.jsonl files older than keepDays (default 14). */
  prune(): void {
    const keep = this.opts.keepDays ?? 14;
    const cutoff = this.now.getTime() - keep * 86_400_000;
    let names: string[];
    try {
      names = fs.readdirSync(this.folder);
    } catch {
      return;
    }
    for (const name of names) {
      const m = name.match(/^gep-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (m && Date.parse(`${m[1]}T00:00:00Z`) < cutoff) {
        try {
          fs.rmSync(path.join(this.folder, name));
        } catch {
          /* ignore */
        }
      }
    }
  }
}
