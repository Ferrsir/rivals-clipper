// Notices when Marvel Rivals starts and stops, without Overwolf, by checking the Windows process list.
// It only lists process names and ids (tasklist), the same as Task Manager; it never opens the game.

import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';

/** The game itself. Marvel.exe and MarvelRivals_Launcher.exe only start it. */
export const GAME_EXE = 'Marvel-Win64-Shipping.exe';

export interface GameSeen {
  pid: number;
  name: string;
}

/** Parses `tasklist /FO CSV /NH` output. */
export function parseTasklist(csv: string, exe = GAME_EXE): GameSeen | undefined {
  for (const line of csv.split(/\r?\n/)) {
    const cols = line.match(/"([^"]*)"/g)?.map((c) => c.slice(1, -1));
    if (!cols || cols.length < 2) continue;
    if (cols[0].toLowerCase() === exe.toLowerCase()) {
      const pid = Number(cols[1]);
      if (Number.isFinite(pid) && pid > 0) return { pid, name: cols[0] };
    }
  }
  return undefined;
}

/** Events: 'launched' (game: GameSeen), 'exit' (). */
export class GameWatcher extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private current?: GameSeen;
  private busy = false;
  private generation = 0;

  constructor(private intervalMs = 3000, private exe = GAME_EXE,
    private query?: (done: (err: Error | null, stdout: string) => void) => void) {
    super();
  }

  get game(): GameSeen | undefined {
    return this.current;
  }

  start(): void {
    if (this.timer || (process.platform !== 'win32' && !this.query)) return;
    this.generation++;
    const tick = () => void this.check();
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }

  /** Stops watching. Starting again reports a game that is already running as launched. */
  stop(): void {
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.current = undefined;
  }

  private check(): Promise<void> {
    if (this.busy) return Promise.resolve();
    this.busy = true;
    const generation = this.generation;
    return new Promise((resolve) => {
      const query = this.query ?? ((done: (err: Error | null, stdout: string) => void) =>
        execFile('tasklist', ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${this.exe}`], { windowsHide: true, timeout: 10_000 }, done));
      query((err, stdout) => {
        this.busy = false;
        if (err || generation !== this.generation) return resolve();
        this.update(parseTasklist(String(stdout), this.exe));
        resolve();
      });
    });
  }

  /** Exposed for tests. */
  update(seen: GameSeen | undefined): void {
    if (seen && (!this.current || this.current.pid !== seen.pid)) {
      if (this.current) this.emit('exit');
      this.current = seen;
      this.emit('launched', seen);
    } else if (!seen && this.current) {
      this.current = undefined;
      this.emit('exit');
    }
  }
}
