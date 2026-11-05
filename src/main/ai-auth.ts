// Sign-in to Claude or ChatGPT through their official command-line apps (Claude Code and Codex).
// You log in on Anthropic's or OpenAI's own page in your browser; this app never sees your password
// or tokens. AI work then runs on your existing subscription.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type AiProvider = 'claude' | 'codex';

export interface ProviderStatus {
  provider: AiProvider;
  installed: boolean;
  loggedIn: boolean;
  detail?: string;
  /** Which account is signed in, when the CLI reports it (e.g. an email). */
  account?: string;
}

interface ProviderDef {
  label: string;
  bin: string;
  status: string[];
  login: string[];
  parseLoggedIn: (stdout: string) => boolean;
  /** PowerShell command shown to and run for the user if the CLI is missing. */
  install: string;
}

export const PROVIDERS: Record<AiProvider, ProviderDef> = {
  claude: {
    label: 'Claude',
    bin: 'claude',
    status: ['auth', 'status', '--json'],
    login: ['auth', 'login', '--claudeai'],
    parseLoggedIn: (out) => {
      try {
        return JSON.parse(out).loggedIn === true;
      } catch {
        return false;
      }
    },
    install: 'irm https://claude.ai/install.ps1 | iex',
  },
  codex: {
    label: 'ChatGPT',
    bin: 'codex',
    status: ['login', 'status'],
    login: ['login'],
    parseLoggedIn: (out) => /logged in/i.test(out) && !/not logged in/i.test(out),
    install: 'npm install -g @openai/codex',
  },
};

/** Quote one argument for cmd.exe so paths with spaces stay a single argument. */
export function quoteWinArg(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>^%()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

const resolved = new Map<string, string | undefined>();

/** On Windows, find the real executable (claude.exe, or an npm .cmd shim) via `where`. */
async function resolveBin(bin: string): Promise<string | undefined> {
  if (process.platform !== 'win32') return bin;
  if (resolved.has(bin)) return resolved.get(bin);
  const found = await new Promise<string | undefined>((resolve) => {
    const child = spawn('where.exe', [bin], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(undefined));
    child.on('close', () => {
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      resolve(lines.find((l) => /\.exe$/i.test(l)) ?? lines.find((l) => /\.(cmd|bat)$/i.test(l)));
    });
  });
  resolved.set(bin, found);
  return found;
}

/** Spawn without losing argument boundaries: .exe directly, .cmd shims through cmd.exe with each arg quoted. */
async function spawnCli(bin: string, args: string[], opts: { cwd?: string } = {}) {
  const exe = await resolveBin(bin);
  if (!exe) return undefined;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe)) {
    const line = [quoteWinArg(exe), ...args.map(quoteWinArg)].join(' ');
    return spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { windowsHide: true, windowsVerbatimArguments: true, cwd: opts.cwd });
  }
  return spawn(exe, args, { windowsHide: true, cwd: opts.cwd });
}

async function run(bin: string, args: string[], opts: { timeoutMs?: number; input?: string; cwd?: string } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = await spawnCli(bin, args, { cwd: opts.cwd });
  if (!child) return { code: -1, stdout: '', stderr: `${bin} not found` };
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 15_000);
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

/** Best-effort account label from the CLI's status output (fields vary by version). */
export function accountOf(stdout: string): string | undefined {
  try {
    const j = JSON.parse(stdout);
    const v = j.email ?? j.account?.email ?? j.accountEmail ?? j.user?.email ?? j.organization?.name ?? j.orgName;
    return typeof v === 'string' && v ? v : undefined;
  } catch {
    const m = stdout.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    return m?.[0];
  }
}

export async function checkStatus(provider: AiProvider): Promise<ProviderStatus> {
  const def = PROVIDERS[provider];
  resolved.delete(def.bin); // re-detect, e.g. right after the user installed it
  const version = await run(def.bin, ['--version']);
  if (version.code !== 0) return { provider, installed: false, loggedIn: false };
  const st = await run(def.bin, def.status);
  return { provider, installed: true, loggedIn: def.parseLoggedIn(st.stdout + st.stderr), detail: version.stdout.trim(), account: accountOf(st.stdout) };
}

/** Opens a visible PowerShell window that installs the CLI, so you can see exactly what runs. */
export function openInstaller(provider: AiProvider): void {
  const cmd = PROVIDERS[provider].install;
  spawn('cmd.exe', ['/c', 'start', 'powershell', '-NoExit', '-Command', cmd], { detached: true, windowsHide: false }).unref();
}

/** Starts the provider's browser login, then polls until signed in (or gives up after 5 minutes). */
export async function login(provider: AiProvider, onUpdate: (s: ProviderStatus) => void): Promise<ProviderStatus> {
  const def = PROVIDERS[provider];
  const child = await spawnCli(def.bin, def.login);
  child?.on('error', () => undefined);
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const s = await checkStatus(provider);
    onUpdate(s);
    if (s.loggedIn) {
      child?.kill();
      return s;
    }
  }
  child?.kill();
  return checkStatus(provider);
}

export async function logout(provider: AiProvider): Promise<void> {
  await run(PROVIDERS[provider].bin, provider === 'claude' ? ['auth', 'logout'] : ['logout']);
}

/**
 * Ask the signed-in AI a one-shot question, optionally with image files (e.g. clip frames).
 * Used by AI tagging and the Studio. Runs with no tools and no write access.
 */
export async function ask(provider: AiProvider, prompt: string, images: string[] = [], timeoutMs = 120_000): Promise<string> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rivals-ai-'));
  try {
    if (provider === 'claude') {
      const withImages = images.length ? `${prompt}\n\nImages to look at:\n${images.map((p) => `- ${p}`).join('\n')}` : prompt;
      // --tools limits the built-in tool set to Read; --strict-mcp-config with no --mcp-config
      // drops every MCP server, so nothing inherited from the user's settings can write or run commands.
      const args = ['-p', '--output-format', 'json', '--tools', 'Read', '--strict-mcp-config'];
      for (const img of images) args.push('--add-dir', path.dirname(img));
      const r = await run('claude', args, { timeoutMs, input: withImages, cwd: work });
      let parsed: {result?: string; is_error?: boolean};
      try { parsed = JSON.parse(r.stdout); } catch { throw new Error(r.stderr || 'Claude returned an unreadable response'); }
      if (r.code !== 0 || parsed.is_error) throw new Error(parsed.result || r.stderr || 'Claude request failed');
      return String(parsed.result ?? '');
    }
    const outFile = path.join(work, 'answer.txt');
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-o', outFile];
    for (const img of images) args.push('-i', img);
    args.push('-');
    const r = await run('codex', args, { timeoutMs, input: prompt, cwd: work });
    if (r.code !== 0) throw new Error(r.stderr || 'ChatGPT request failed');
    return fs.readFileSync(outFile, 'utf8');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ---------- main-process AI client (used by AI tagging and the Studio) ----------

export interface AiAskOptions {
  prompt: string;
  system?: string;
  imagePaths?: string[];
  /** Ask for a single JSON value back and parse it. `text` stays the raw reply. */
  expectJson?: boolean;
  timeoutMs?: number;
}

export interface AiAskResult {
  text: string;
  provider: AiProvider;
  json?: unknown;
}

export interface AiClient {
  status(): Promise<{ signedIn: boolean; provider: AiProvider | 'none' }>;
  ask(opts: AiAskOptions): Promise<AiAskResult>;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error('AI reply had no JSON');
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  return JSON.parse(body.slice(start, end + 1));
}

export function createAiClient(getProvider: () => AiProvider | 'none'): AiClient {
  return {
    async status() {
      const provider = getProvider();
      if (provider === 'none') return { signedIn: false, provider };
      const s = await checkStatus(provider);
      return { signedIn: s.loggedIn, provider };
    },
    async ask(opts) {
      const provider = getProvider();
      if (provider === 'none') throw new Error('Sign in to Claude or ChatGPT first (Settings, Account).');
      const parts = [opts.system ? `Instructions:\n${opts.system}` : '', opts.prompt];
      if (opts.expectJson) parts.push('Reply with only one JSON value and no other text.');
      const text = await ask(provider, parts.filter(Boolean).join('\n\n'), opts.imagePaths ?? [], opts.timeoutMs);
      return { text, provider, json: opts.expectJson ? extractJson(text) : undefined };
    },
  };
}
