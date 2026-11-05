// Reel projects: JSON files in <root>\studio\projects. Clips are referenced, never copied or changed.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ClipSidecar } from '../../shared/types';
import type { CaptionLine, FormatId, IntroCard, ReelClip, ReelProject } from '../../shared/studio';
import { FORMATS, getFormat } from './formats';
import { clone, getStyle, sanitizeMix, sanitizeStyle } from './styles';

export function newId(): string {
  return crypto.randomBytes(6).toString('hex');
}

/** Turn a library clip into a reel clip. Kill times come from the sidecar's events. */
export function reelClipFromSidecar(c: ClipSidecar): ReelClip {
  const dur = Math.max(0.5, (c.durationMs || 0) / 1000);
  const hits = c.events
    .filter((e) => e.type === 'kill')
    .map((e) => (e.at - c.startTimeEpoch) / 1000)
    .filter((t) => t > 0 && t < dur)
    .sort((a, b) => a - b);
  return {
    uid: newId(),
    clipId: c.id,
    videoFile: c.videoFile,
    hero: c.hero,
    map: c.match?.map,
    kills: c.events.filter((e) => e.type === 'kill').length,
    score: c.score,
    tags: c.tags.filter((t) => !t.includes(':')),
    durationSec: dur,
    width: c.video?.width || 0,
    height: c.video?.height || 0,
    fps: c.video?.fps || 60,
    hasMic: c.audioTracks.length > 1,
    hits,
    in: 0,
    out: dur,
    useMic: c.audioTracks.length > 1 && c.useMic,
    cropX: 0.5,
    cropY: 0.5,
    cropZoom: 1,
  };
}

export function createProject(opts: { name?: string; format?: FormatId; styleId?: string } = {}): ReelProject {
  const format = getFormat(opts.format ?? 'tiktok');
  const style = getStyle(opts.styleId ?? 'story');
  const now = Date.now();
  return {
    version: 1,
    id: newId(),
    name: opts.name?.trim() || `Reel ${new Date(now).toLocaleDateString()}`,
    createdAt: now,
    updatedAt: now,
    format: format.id,
    fps: format.fps,
    style,
    clips: [],
    music: null,
    mix: clone(style.mix),
    order: 'manual',
    captions: [],
    intro: null,
  };
}

/** Hook text: up to 4 lines of up to 80 characters each. */
export function hookText(v: unknown): string {
  return String(v ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, 4)
    .join('\n');
}

const num = (v: unknown, lo: number, hi: number, fb: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
};

function sanitizeClip(c: any): ReelClip | null {
  if (!c || typeof c.videoFile !== 'string' || !c.videoFile) return null;
  const dur = num(c.durationSec, 0.1, 3600, 10);
  const inn = num(c.in, 0, dur, 0);
  const out = num(c.out, inn + 0.1, dur, dur);
  return {
    uid: typeof c.uid === 'string' && c.uid ? c.uid.slice(0, 40) : newId(),
    clipId: String(c.clipId ?? '').slice(0, 200),
    videoFile: c.videoFile,
    hero: typeof c.hero === 'string' ? c.hero.slice(0, 60) : undefined,
    map: typeof c.map === 'string' ? c.map.slice(0, 80) : undefined,
    kills: num(c.kills, 0, 99, 0),
    score: num(c.score, -1e6, 1e6, 0),
    tags: Array.isArray(c.tags) ? c.tags.filter((t: unknown) => typeof t === 'string').slice(0, 30) : [],
    durationSec: dur,
    width: num(c.width, 0, 10000, 0),
    height: num(c.height, 0, 10000, 0),
    fps: num(c.fps, 1, 480, 60),
    preserveKillFeed: c.preserveKillFeed !== false,
    followCharacter: c.followCharacter !== false,
    hasMic: !!c.hasMic,
    hits: Array.isArray(c.hits) ? c.hits.map(Number).filter((h: number) => Number.isFinite(h) && h >= 0 && h <= dur).sort((a: number, b: number) => a - b).slice(0, 40) : [],
    in: inn,
    out,
    useMic: !!c.useMic && !!c.hasMic,
    muteGame: !!c.muteGame,
    cropX: num(c.cropX, 0, 1, 0.5),
    cropY: num(c.cropY, 0, 1, 0.5),
    cropZoom: num(c.cropZoom, 1, 3, 1),
  };
}

/** Accept a project from the renderer or disk, keeping only valid, clamped fields. */
export function sanitizeProject(p: any): ReelProject {
  const base = createProject();
  if (!p || typeof p !== 'object') return base;
  const format = FORMATS[p.format as FormatId] ? (p.format as FormatId) : base.format;
  const f = getFormat(format);
  const style = sanitizeStyle(p.style, getStyle(typeof p.style?.id === 'string' ? p.style.id : 'story'));
  const captions: CaptionLine[] = Array.isArray(p.captions)
    ? p.captions
        .filter((c: any) => c && typeof c.text === 'string')
        .slice(0, 60)
        .map((c: any) => ({
          text: c.text.slice(0, 140),
          ...(Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start ? { start: Number(c.start), end: Number(c.end) } : {}),
        }))
    : [];
  const intro: IntroCard | null =
    p.intro && typeof p.intro === 'object'
      ? { image: typeof p.intro.image === 'string' && p.intro.image ? p.intro.image : undefined, imageCredit: typeof p.intro.imageCredit === 'string' && p.intro.imageCredit ? p.intro.imageCredit.slice(0, 300) : undefined, text: hookText(p.intro.text), seconds: num(p.intro.seconds, 1, 15, 4), layout: p.intro.layout === 'full' ? 'full' : 'band' }
      : null;
  const music =
    p.music && typeof p.music.file === 'string' && p.music.file
      ? {
          trackId: String(p.music.trackId ?? ''),
          file: p.music.file,
          title: String(p.music.title ?? path.basename(p.music.file)).slice(0, 120),
          start: p.music.start === 'auto' || p.music.start === undefined ? ('auto' as const) : num(p.music.start, 0, 36000, 0),
        }
      : null;
  return {
    version: 1,
    id: typeof p.id === 'string' && /^[a-z0-9-]{1,40}$/i.test(p.id) ? p.id : base.id,
    name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 80) : base.name,
    createdAt: num(p.createdAt, 0, 1e14, base.createdAt),
    updatedAt: Date.now(),
    format,
    fps: f.fpsOptions.includes(Number(p.fps)) ? Number(p.fps) : f.fps,
    style,
    clips: (Array.isArray(p.clips) ? p.clips : []).map(sanitizeClip).filter((c: ReelClip | null): c is ReelClip => !!c).slice(0, 80),
    music,
    mix: sanitizeMix(p.mix, style.mix),
    order: p.order === 'build-up' ? 'build-up' : 'manual',
    heroUid: typeof p.heroUid === 'string' ? p.heroUid : undefined,
    captions,
    intro,
    outro:
      p.outro && typeof p.outro === 'object' && String(p.outro.text ?? '').trim()
        ? { text: String(p.outro.text).replace(/\s+/g, ' ').trim().slice(0, 100), seconds: num(p.outro.seconds, 1, 8, 3) }
        : null,
    caption: typeof p.caption === 'string' ? p.caption.slice(0, 2200) : undefined,
    lastExports: Array.isArray(p.lastExports) ? p.lastExports.slice(-20) : undefined,
  };
}

export class ProjectStore {
  constructor(private dir: string) {}

  private file(id: string) {
    if (!/^[a-z0-9-]{1,40}$/i.test(id)) throw new Error('Bad project id');
    return path.join(this.dir, `${id}.json`);
  }

  list(): Array<Pick<ReelProject, 'id' | 'name' | 'updatedAt' | 'format'> & { clips: number }> {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          try {
            const p = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as ReelProject;
            return { id: p.id, name: p.name, updatedAt: p.updatedAt, format: p.format, clips: p.clips?.length ?? 0 };
          } catch {
            return null;
          }
        })
        .filter((x): x is NonNullable<typeof x> => !!x)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  get(id: string): ReelProject | undefined {
    try {
      return sanitizeProject(JSON.parse(fs.readFileSync(this.file(id), 'utf8')));
    } catch {
      return undefined;
    }
  }

  save(p: unknown): ReelProject {
    const clean = sanitizeProject(p);
    fs.mkdirSync(this.dir, { recursive: true });
    const f = this.file(clean.id);
    fs.writeFileSync(f + '.tmp', JSON.stringify(clean, null, 2));
    fs.renameSync(f + '.tmp', f);
    return clean;
  }

  delete(id: string): void {
    fs.rmSync(this.file(id), { force: true });
  }
}
