// Phase 0: append every raw GEP event and info update to a daily JSONL file,
// so we can see exactly what Marvel Rivals reports and when.

import fs from 'node:fs';
import path from 'node:path';

export class EventLog {
  constructor(private folder: string) {}

  write(kind: string, data: unknown): void {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const line = JSON.stringify({ t: now.getTime(), iso: now.toISOString(), kind, data }) + '\n';
    try {
      fs.appendFileSync(path.join(this.folder, `gep-${day}.jsonl`), line);
    } catch {
      /* never let logging break clipping */
    }
  }
}
