// In-app updates: checks the latest GitHub release, downloads its Setup .exe and installs it silently.
// Clips, settings and the Library live in the library folder (F:\RivalsClips by default), which the
// installer never touches. The install only starts when nothing is being recorded or saved, and after
// this app has fully closed, so a clip that is still being written always finishes first.

import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const RELEASES_API = 'https://api.github.com/repos/Ferrsir/rivals-clipper/releases/latest';
export const INSTALLER_NAME = /^RivalsClipper-Setup-(\d+\.\d+\.\d+)\.exe$/i;

export interface ReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
  /** GitHub's own checksum of the upload, "sha256:<hex>". Older releases may not have it. */
  digest?: string | null;
}
export interface Release {
  tag_name: string;
  name?: string | null;
  html_url?: string;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  assets: ReleaseAsset[];
}

export type UpdatePhase = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'waiting' | 'installing' | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  current: string;
  latest?: string;
  notes?: string;
  releaseUrl?: string;
  /** 0..1 while downloading. */
  progress?: number;
  /** Why the install is waiting (recording) or why something failed. */
  message?: string;
  checkedAt?: number;
}

/** Numeric compare of "x.y.z" (a leading "v" is fine). Positive when a is newer. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.trim().replace(/^v/i, '').split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The Windows installer attached to a release, if it has one. */
export function pickInstaller(release: Release): ReleaseAsset | undefined {
  return release.assets.find((a) => INSTALLER_NAME.test(a.name));
}

/** True when `child` is `parent` or somewhere inside it (case-insensitive, as on Windows). */
export function isInside(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  const rel = path.win32.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.win32.isAbsolute(rel));
}

export interface BusyState {
  /** Marvel Rivals is open, so the replay buffer is (or is about to be) recording. */
  gameRunning: boolean;
  /** A clip is being captured, saved or checked. */
  clipping: boolean;
}

/** Why installing now would interrupt something, or undefined when it is safe. */
export function busyReason(s: BusyState): string | undefined {
  if (s.clipping) return 'A clip is still being saved.';
  if (s.gameRunning) return 'Marvel Rivals is open, so the replay buffer is recording.';
  return undefined;
}

/**
 * A PowerShell line that waits for this app's process to exit, then runs the installer silently.
 * "/S" keeps the folder you installed to; "--updated --force-run" reopens the app afterwards.
 */
export function installerCommand(pid: number, setupPath: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return [
    `Wait-Process -Id ${pid} -Timeout 180 -ErrorAction SilentlyContinue;`,
    `Start-Sleep -Seconds 1;`,
    `Start-Process -FilePath ${q(setupPath)} -ArgumentList '/S','--updated','--force-run'`,
  ].join(' ');
}

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  body: ReadableStream<Uint8Array> | null;
  headers: { get(name: string): string | null };
}>;

export interface UpdaterDeps {
  currentVersion: string;
  /** Where downloads go (a temp folder). */
  downloadDir: string;
  /** The folder the app runs from. The library must not be inside it. */
  installDir: string;
  libraryFolder: () => string;
  busy: () => BusyState;
  /** Closes the app the normal way (clips finish saving first). */
  quit: () => void;
  onChange: (state: UpdateState) => void;
  pid?: number;
  platform?: NodeJS.Platform;
  fetch?: FetchLike;
  /** Starts a detached process. May return a promise that rejects when it couldn't start. */
  spawn?: (cmd: string, args: string[]) => void | Promise<void>;
  /** Packaged build? Running from source can't update itself. */
  packaged?: boolean;
  /** One line per step (check, download, wait, launch), so a stuck update can be explained. */
  log?: (line: string) => void;
}

export class Updater {
  private state: UpdateState;
  private release?: Release;
  private asset?: ReleaseAsset;
  private setupPath?: string;
  private download?: Promise<void>;
  /** Install was asked for while recording: do it once the game closes. */
  private queued = false;

  constructor(private deps: UpdaterDeps) {
    this.state = { phase: 'idle', current: deps.currentVersion };
  }

  get status(): UpdateState {
    return { ...this.state };
  }

  private set(patch: Partial<UpdateState>) {
    const before = this.state.phase;
    this.state = { ...this.state, ...patch };
    const withVersion = ['available', 'downloading', 'ready', 'waiting', 'installing'].includes(this.state.phase);
    if (patch.phase && patch.phase !== before) this.note(`${patch.phase}${withVersion && this.state.latest ? ` ${this.state.latest}` : ''}${patch.message ? `: ${patch.message}` : ''}`);
    this.deps.onChange(this.status);
  }

  private note(line: string) {
    try {
      this.deps.log?.(line);
    } catch {
      /* logging never breaks an update */
    }
  }

  private get fetch(): FetchLike {
    return this.deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  async check(): Promise<UpdateState> {
    if (['downloading', 'installing'].includes(this.state.phase)) return this.status;
    const keep = this.state.phase === 'ready' || this.state.phase === 'waiting' ? this.state.phase : undefined;
    if (!keep) this.set({ phase: 'checking', message: undefined });
    try {
      const res = await this.fetch(RELEASES_API, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'rivals-clipper-updater' },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 404) {
        this.set({ phase: 'up-to-date', checkedAt: Date.now(), message: 'No releases have been published yet.' });
        return this.status;
      }
      if (!res.ok) throw new Error(`GitHub answered ${res.status}${res.status === 403 ? ' (too many checks, try again in an hour)' : ''}`);
      const release = (await res.json()) as Release;
      // A download started while this check was out: leave it alone, the next check picks up anything newer.
      if (this.download) return this.status;
      const asset = pickInstaller(release);
      const latest = release.tag_name.replace(/^v/i, '');
      const newer = compareVersions(latest, this.deps.currentVersion) > 0;
      if (!newer) {
        this.set({ phase: 'up-to-date', latest, checkedAt: Date.now(), message: undefined });
        return this.status;
      }
      if (!asset) throw new Error(`Version ${latest} is out but has no Windows installer attached yet.`);
      if (this.release && this.release.tag_name !== release.tag_name) {
        // A newer version replaced the one that was downloaded (and maybe queued): start over with it.
        this.setupPath = undefined;
        this.queued = false;
      }
      this.release = release;
      this.asset = asset;
      this.set({
        phase: keep && this.setupPath ? keep : 'available',
        latest,
        notes: (release.body ?? '').slice(0, 2000),
        releaseUrl: release.html_url,
        checkedAt: Date.now(),
        message: undefined,
      });
    } catch (err) {
      if (keep) return this.status;
      this.set({ phase: 'error', checkedAt: Date.now(), message: `Could not check for updates: ${(err as Error).message}` });
    }
    return this.status;
  }

  /**
   * Download (if needed) and install. Waits for the game to close when it is recording, unless `force`
   * ("Install now anyway": the app thinks the game is open but you know it isn't).
   */
  async install(force = false): Promise<UpdateState> {
    if ((this.deps.platform ?? process.platform) !== 'win32') return this.fail('Updates install on Windows only.');
    if (this.deps.packaged === false) return this.fail('This copy runs from source. Use git pull instead.');
    const library = this.deps.libraryFolder();
    if (isInside(library, this.deps.installDir)) {
      return this.fail(`Your clips folder (${library}) is inside the app folder, so the installer could replace it. Move it in Settings first.`);
    }
    if (!this.asset) {
      await this.check();
      if (!this.asset) return this.status;
    }
    try {
      await this.fetchInstaller();
    } catch (err) {
      return this.fail(`Download failed: ${(err as Error).message}`);
    }
    // "Install now anyway" overrides only the game check (it can be wrong); a clip still saving always waits.
    const busy = this.deps.busy();
    const why = busyReason(force ? { ...busy, gameRunning: false } : busy);
    if (why) {
      this.queued = true;
      this.set({ phase: 'waiting', message: `${why} The update installs by itself when you close the game or this app.` });
      return this.status;
    }
    if (force && busy.gameRunning) this.note('installing now (asked to install anyway while the game looked open)');
    return this.launch();
  }

  /**
   * The app is closing. A queued install runs now: everything has stopped recording and saving, and
   * waiting for the next launch would throw it away. Returns true when the installer was started.
   */
  onQuit(opts: { sessionEnding?: boolean } = {}): boolean {
    if (!this.queued || !this.setupPath || !fs.existsSync(this.setupPath)) return false;
    // Windows is shutting down (an installer could be killed halfway), or the game is still being played:
    // keep it for later; the next check finds it again.
    if (opts.sessionEnding || this.deps.busy().gameRunning) {
      this.note(`app closing with an install queued; not installing (${opts.sessionEnding ? 'Windows is shutting down' : 'the game is open'})`);
      return false;
    }
    this.queued = false;
    this.note('app closing with an install queued: installing now');
    // Fire and forget: the app is already on its way out.
    void this.start();
    return true;
  }

  /** Called when the game closes or a clip finishes saving: runs a queued install if it is now safe. */
  idle(): void {
    if (!this.queued || busyReason(this.deps.busy())) return;
    void this.launch();
  }

  /** Forget a queued install (the user changed their mind). */
  cancel(): UpdateState {
    this.queued = false;
    if (this.state.phase === 'waiting') this.set({ phase: 'ready', message: undefined });
    return this.status;
  }

  private fail(message: string): UpdateState {
    this.set({ phase: 'error', message });
    return this.status;
  }

  private async fetchInstaller(): Promise<void> {
    if (this.setupPath && fs.existsSync(this.setupPath)) return;
    this.download ??= this.downloadNow().finally(() => { this.download = undefined; });
    return this.download;
  }

  private async downloadNow(): Promise<void> {
    const asset = this.asset!;
    fs.mkdirSync(this.deps.downloadDir, { recursive: true });
    const final = path.join(this.deps.downloadDir, asset.name);
    const part = `${final}.part`;
    this.set({ phase: 'downloading', progress: 0, message: undefined });
    const res = await this.fetch(asset.browser_download_url, {
      headers: { 'User-Agent': 'rivals-clipper-updater', Accept: 'application/octet-stream' },
      signal: AbortSignal.timeout(15 * 60_000),
    });
    if (!res.ok || !res.body) throw new Error(`GitHub answered ${res.status}`);
    const total = asset.size || Number(res.headers.get('content-length')) || 0;
    const hash = createHash('sha256');
    const out = fs.createWriteStream(part);
    let got = 0;
    let lastPct = -1;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        got += value.length;
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
        const pct = total ? Math.floor((got / total) * 100) : 0;
        if (pct !== lastPct) {
          lastPct = pct;
          this.set({ progress: total ? got / total : undefined });
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    } catch (err) {
      out.destroy();
      fs.rmSync(part, { force: true });
      throw err;
    }
    if (asset.size && got !== asset.size) {
      fs.rmSync(part, { force: true });
      throw new Error(`got ${got} bytes, expected ${asset.size}`);
    }
    const want = asset.digest?.match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase();
    if (want && hash.digest('hex') !== want) {
      fs.rmSync(part, { force: true });
      throw new Error('the file does not match GitHub\'s checksum');
    }
    fs.rmSync(final, { force: true });
    fs.renameSync(part, final);
    this.setupPath = final;
    this.set({ phase: 'ready', progress: 1 });
  }

  /**
   * Starts the PowerShell that waits for this app to exit and then runs the installer. Resolves once it has
   * really started: a spawn failure arrives as a later 'error' event, and the app must not quit on one.
   */
  private async start(): Promise<boolean> {
    const setup = this.setupPath!;
    const run = this.deps.spawn ?? ((cmd: string, args: string[]) => new Promise<void>((resolve, reject) => {
      const child = nodeSpawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
      child.once('error', reject);
    }));
    try {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', installerCommand(this.deps.pid ?? process.pid, setup)]);
      this.note(`started installer ${setup}`);
      return true;
    } catch (err) {
      this.queued = false;
      this.fail(`Could not start the installer: ${(err as Error).message}`);
      return false;
    }
  }

  private async launch(): Promise<UpdateState> {
    // Whatever was queued is being installed now: it must not start a second time from idle() or onQuit().
    this.queued = false;
    if (!(await this.start())) return this.status;
    this.set({ phase: 'installing', message: 'Closing to install. The app reopens by itself in about a minute.' });
    this.deps.quit();
    return this.status;
  }
}
