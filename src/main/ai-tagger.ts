// AI tagging: grabs a few frames around each clip's kills and asks your signed-in Claude or ChatGPT
// what kind of play it is. The answer (style tags, a one-line summary and a hype score) is stored in
// the clip's sidecar, feeds the score, and makes clips searchable by style.
//
// Runs one clip at a time, only while you are not mid-match, so it never competes with the game.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AiClient } from './ai-auth';
import type { ClipAiInfo, ClipSidecar } from '../shared/types';

/** Tags the AI is encouraged to use, so the Library's chips stay consistent across clips. */
export const STYLE_TAGS = [
  'flank', 'dive', 'peel', 'backline', 'off-angle', 'high-ground', 'environment-kill', 'ult-combo', 'team-up',
  'flick', 'tracking', 'headshots', 'outplay', 'low-hp', 'escape', 'trade', 'cleanup', 'chaotic', 'clean', 'funny',
] as const;

const MAX_FRAMES = 4;
const MAX_TAGS = 6;

/** Times (ms into the clip) worth looking at: just after each kill, spread out, at most MAX_FRAMES. */
export function frameTimesMs(clip: Pick<ClipSidecar, 'events' | 'startTimeEpoch' | 'durationMs'>): number[] {
  const end = Math.max(0, clip.durationMs - 100);
  const kills = clip.events
    .filter((e) => e.type === 'kill')
    .map((e) => Math.min(end, Math.max(0, e.at - clip.startTimeEpoch + 150)))
    .sort((a, b) => a - b);
  if (!kills.length) return [Math.round(end * 0.35), Math.round(end * 0.65)];
  if (kills.length <= MAX_FRAMES) return kills;
  // Keep the first and last kill and spread the rest evenly.
  const picks = new Set<number>();
  for (let i = 0; i < MAX_FRAMES; i++) picks.add(kills[Math.round((i * (kills.length - 1)) / (MAX_FRAMES - 1))]);
  return [...picks];
}

export function buildPrompt(clip: ClipSidecar): string {
  const kills = clip.events.filter((e) => e.type === 'kill');
  const victims = kills.map((k) => k.victimHero).filter(Boolean);
  const facts = [
    `Hero played: ${clip.hero ?? 'unknown'}`,
    `Kills in clip: ${kills.length}${victims.length ? ` (${victims.join(', ')})` : ''}`,
    clip.match.map ? `Map: ${clip.match.map}` : '',
    clip.match.gameType ? `Mode: ${clip.match.gameType}` : '',
    clip.ultUsedBeforeKills ? 'The player used their ultimate just before the kills.' : '',
    clip.tags.length ? `Already detected: ${clip.tags.filter((t) => !t.includes(':')).join(', ')}` : '',
  ].filter(Boolean);
  return [
    'These images are frames from a Marvel Rivals highlight clip, taken just after each kill, in order.',
    facts.join('\n'),
    `Describe the play. Pick up to ${MAX_TAGS} style tags, preferring these: ${STYLE_TAGS.join(', ')}. Only use a tag if the frames or facts support it.`,
    'Write a summary of at most 14 words, like a caption a viewer would read. Rate hype from 1 (routine) to 10 (incredible).',
    'Reply as JSON: {"tags": ["..."], "summary": "...", "hype": 7}',
  ].join('\n\n');
}

const slug = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);

/** Validate whatever the AI sent back. Never throws: bad fields are dropped or clamped. */
export function parseReply(json: unknown): Pick<ClipAiInfo, 'tags' | 'summary' | 'hype'> {
  const j = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const rawTags = Array.isArray(j.tags) ? j.tags : [];
  const tags = [...new Set(rawTags.filter((t): t is string => typeof t === 'string').map(slug).filter(Boolean))].slice(0, MAX_TAGS);
  const summary = typeof j.summary === 'string' ? j.summary.replace(/\s+/g, ' ').trim().slice(0, 140) : '';
  const n = Number(j.hype);
  const hype = Number.isFinite(n) ? Math.min(10, Math.max(1, Math.round(n))) : 5;
  return { tags, summary, hype };
}

export function frameArgs(videoFile: string, atMs: number, outFile: string): string[] {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-ss', (atMs / 1000).toFixed(3), '-i', videoFile, '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '4', outFile];
}

function grabFrame(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, args, { timeout: 30_000, windowsHide: true }, (err, _o, stderr) => (err ? reject(new Error(String(stderr) || err.message)) : resolve()));
  });
}

export interface TaggerDeps {
  ai: AiClient;
  /** Resolves an ffmpeg binary, or undefined when none is available. */
  ffmpeg: () => Promise<string | undefined>;
  /** Writes the result into the clip's sidecar and returns the updated clip. */
  save: (videoFile: string, info: ClipAiInfo) => ClipSidecar | undefined;
  read: (videoFile: string) => ClipSidecar | undefined;
  /** False while a match or clip is in progress; tagging waits until it is true. */
  canRun: () => boolean;
  enabled: () => boolean;
  onTagged?: (clip: ClipSidecar) => void;
  onStatus?: (msg: string) => void;
}

export class AiTagger {
  private queue: string[] = [];
  private busy = false;
  private draining = false;
  private timer: NodeJS.Timeout | undefined;
  /** Every tagging job, automatic or manual, runs through this chain, so only one runs at a time. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private d: TaggerDeps) {}

  get pending(): number {
    return this.queue.length + (this.busy ? 1 : 0);
  }

  enqueue(videoFile: string, front = false): void {
    if (this.queue.includes(videoFile)) return;
    if (front) this.queue.unshift(videoFile);
    else this.queue.push(videoFile);
    this.kick();
  }

  /** Try again soon; called after a match ends or a clip finishes saving. */
  kick(delayMs = 2000): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.drain(), delayMs);
  }

  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = async () => {
      this.busy = true;
      try {
        return await job();
      } finally {
        this.busy = false;
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async drain(): Promise<void> {
    if (this.draining) return; // reserved before any await, so two drains never overlap
    this.draining = true;
    try {
      while (this.queue.length) {
        if (!this.d.enabled()) return;
        if (!this.d.canRun()) return this.kick(15_000);
        const status = await this.d.ai.status().catch(() => ({ signedIn: false }));
        if (!status.signedIn) return;
        const file = this.queue.shift()!;
        const ran = await this.exclusive(async () => {
          // A match may have started while we waited on the status check or another job.
          if (!this.d.canRun()) return false;
          await this.tagOne(file);
          return true;
        });
        if (!ran) {
          this.queue.unshift(file);
          return this.kick(15_000);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** The "Tag with AI" button: runs even with auto-tagging off, but never during a match or recording. */
  async tagNow(videoFile: string): Promise<ClipSidecar | undefined> {
    if (!this.d.canRun()) throw new Error('A match or recording is in progress. Tag this clip after the match.');
    this.queue = this.queue.filter((f) => f !== videoFile);
    return this.exclusive(() => this.tagOne(videoFile));
  }

  /** Tag one clip. Errors are stored on the clip so it is not retried forever. Callers serialize through exclusive(). */
  private async tagOne(videoFile: string): Promise<ClipSidecar | undefined> {
    const clip = this.d.read(videoFile);
    if (!clip || !fs.existsSync(videoFile)) return undefined;
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rivals-tag-'));
    try {
      const ffmpeg = await this.d.ffmpeg();
      if (!ffmpeg) throw new Error('No ffmpeg found to read frames from the clip.');
      const frames: string[] = [];
      for (const [i, t] of frameTimesMs(clip).entries()) {
        const out = path.join(work, `frame-${i}.jpg`);
        await grabFrame(ffmpeg, frameArgs(videoFile, t, out));
        if (fs.existsSync(out)) frames.push(out);
      }
      if (!frames.length) throw new Error('Could not read any frames from the clip.');
      this.d.onStatus?.(`AI is tagging ${path.basename(videoFile)}`);
      const r = await this.d.ai.ask({ prompt: buildPrompt(clip), imagePaths: frames, expectJson: true, timeoutMs: 180_000 });
      const saved = this.d.save(videoFile, { ...parseReply(r.json), provider: r.provider, at: Date.now() });
      if (saved) this.d.onTagged?.(saved);
      return saved;
    } catch (err) {
      const provider = (await this.d.ai.status().catch(() => ({ provider: 'none' }))).provider;
      const saved = this.d.save(videoFile, {
        tags: [],
        summary: '',
        hype: 0,
        provider: provider === 'codex' ? 'codex' : 'claude',
        at: Date.now(),
        error: String((err as Error).message ?? err).slice(0, 300),
      });
      if (saved) this.d.onTagged?.(saved);
      return saved;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
}

/** Clips that have never been tagged (or failed), newest first. */
export function untagged(clips: ClipSidecar[]): ClipSidecar[] {
  return clips.filter((c) => !c.ai || c.ai.error).sort((a, b) => b.createdAt - a.createdAt);
}
