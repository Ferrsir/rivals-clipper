// Reel projects: JSON files in <root>\studio\projects. Clips are referenced, never copied or changed.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ClipSidecar } from '../../shared/types';
import type { CaptionLine, ClipSubtitle, FormatId, ImageOverlay, IntroCard, MediaAsset, MusicTrack, OverlayKey, ReelClip, ReelIdea, ReelProject } from '../../shared/studio';
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
    sourceFingerprint: sourceFingerprint(c),
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

function sourceFingerprint(c: ClipSidecar): string {
  return crypto.createHash('sha256').update(JSON.stringify([c.videoFile,c.durationMs,c.startTimeEpoch,c.events,c.video])).digest('hex').slice(0,24);
}

/** Refresh stale source facts while preserving valid user trims and crop/mix choices. */
export function reconcileProjectSources(project: ReelProject, library: ClipSidecar[]): ReelProject {
  const byFile = new Map(library.map(c => [path.resolve(c.videoFile), c]));
  const warnings = new Set(project.sourceWarnings ?? []);
  const clips = project.clips.map(clip => {
    if (clip.external) {
      if (!fs.existsSync(clip.videoFile)) warnings.add(`Your clip is missing: ${path.basename(clip.videoFile)}. Add it again or remove it.`);
      return clip;
    }
    const source = byFile.get(path.resolve(clip.videoFile));
    if (!source) {
      warnings.add(`Source unavailable in the clip library: ${path.basename(clip.videoFile)}. Replace or remove this clip before rendering.`);
      return clip;
    }
    const fresh = reelClipFromSidecar(source);
    const changed = clip.sourceFingerprint ? clip.sourceFingerprint !== fresh.sourceFingerprint
      : Math.abs(clip.durationSec - fresh.durationSec) > .05 || clip.width !== fresh.width || clip.height !== fresh.height;
    if (!changed) return {...clip,sourceFingerprint:fresh.sourceFingerprint};
    warnings.add(`Source changed: ${path.basename(clip.videoFile)}. Kill markers and duration were refreshed; review the trim.`);
    const validTrim = clip.in < fresh.durationSec && clip.out > clip.in;
    return {...clip,sourceFingerprint:fresh.sourceFingerprint,durationSec:fresh.durationSec,width:fresh.width,height:fresh.height,
      fps:fresh.fps,hits:fresh.hits,kills:fresh.kills,hero:fresh.hero,tags:fresh.tags,score:fresh.score,hasMic:fresh.hasMic,
      in:validTrim ? Math.max(0,clip.in) : 0,out:validTrim ? Math.min(fresh.durationSec,clip.out) : fresh.durationSec};
  });
  return {...project,clips,sourceWarnings:[...warnings]};
}

export function createProject(opts: { name?: string; format?: FormatId; styleId?: string } = {}): ReelProject {
  const format = getFormat(opts.format ?? 'tiktok');
  const style = getStyle(opts.styleId ?? 'montage');
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

/** Apply an AI edit plan to trusted library sources, never to paths supplied by the model. */
/** A video you dropped into the Studio, as a reel clip. It has no kill markers, so it is trimmed to the beat. */
export function externalClip(a: MediaAsset): ReelClip {
  const dur = Math.max(0.5, a.durationSec || 5);
  return {
    uid: newId(),
    clipId: `asset:${a.id}`,
    videoFile: a.file,
    external: true,
    kills: 0,
    score: 0,
    tags: ['your clip'],
    durationSec: dur,
    width: a.width || 0,
    height: a.height || 0,
    fps: 30,
    hasMic: false,
    hits: [],
    in: 0,
    out: dur,
    useMic: false,
    preserveKillFeed: false,
    followCharacter: false,
    cropX: 0.5,
    cropY: 0.5,
    cropZoom: 1,
  };
}

/** Apply an AI edit plan to trusted library sources, never to paths supplied by the model. */
export function projectFromIdea(idea: ReelIdea, library: ClipSidecar[], tracks: MusicTrack[]): ReelProject {
  if (!idea || !Array.isArray(idea.clipIds)) throw new Error('Not an edit plan.');
  const byId = new Map(library.map(c => [c.id, c]));
  const assets = sanitizeAssets(idea.assets).filter(a => fs.existsSync(a.file));
  const assetById = new Map(assets.map(a => [a.id, a]));
  const used = new Set<string>();
  const uidFor = new Map<string, string>();
  const clips: ReelClip[] = [];
  for (const id of idea.clipIds) {
    if (used.has(id)) throw new Error('The edit plan selects a repeated clip.');
    used.add(id);
    if (id.startsWith('asset:')) {
      const asset = assetById.get(id.slice(6));
      if (!asset || asset.kind !== 'video') throw new Error('The edit plan uses one of your files that is not a video or is missing.');
      const clip = externalClip(asset);
      uidFor.set(id, clip.uid);
      clips.push(clip);
      continue;
    }
    const source = byId.get(id);
    if (!source) throw new Error('The edit plan selects an unavailable clip.');
    const clip = reelClipFromSidecar(source);
    const edit = idea.clipEdits?.find(e => e.clipId === id);
    if (edit) {
      if (!Number.isFinite(edit.in) || !Number.isFinite(edit.out) || edit.in < 0 || edit.out > clip.durationSec + 0.001 || edit.out <= edit.in) throw new Error('The edit plan contains an invalid source trim.');
      if (clip.hits.some(hit => hit <= edit.in + 0.05 || hit >= edit.out - 0.02)) throw new Error('The requested trim removes a marked kill from a streak. Choose another clip or revise the trim.');
      clip.in = edit.in;
      clip.out = Math.min(edit.out, clip.durationSec);
    }
    uidFor.set(id, clip.uid);
    clips.push(clip);
  }
  if (!clips.length) throw new Error('The edit plan contains no clips.');
  const project = createProject({name:idea.title, format:idea.format, styleId:idea.styleId});
  project.clips = clips;
  project.assets = assets;
  project.targetSeconds = idea.targetSeconds;
  project.caption = idea.postCaption;
  project.overlays = sanitizeOverlays((idea.overlays ?? []).map(o => {
    const image = assetById.get(o.assetId.replace(/^asset:/, ''));
    const clipUid = uidFor.get(o.onClip);
    return image?.kind === 'image' && clipUid ? { ...o, image: image.file, clipUid } : null;
  }));
  project.subtitles = sanitizeSubtitles((idea.subtitles ?? []).map(t => ({ ...t, clipUid: uidFor.get(t.onClip) })));
  const track = tracks.find(t => t.id === idea.music?.trackId);
  if (track) {
    const start = idea.music.start ?? 'auto';
    if (typeof start === 'number' && (!Number.isFinite(start) || start < 0 || (track.analysis && start >= track.analysis.durationSec))) throw new Error('The music start is outside the imported song.');
    project.music = {trackId:track.id, file:track.file, title:track.title, start};
  }
  return sanitizeProject(project);
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
    sourceFingerprint: typeof c.sourceFingerprint === 'string' ? c.sourceFingerprint.slice(0,64) : undefined,
    map: typeof c.map === 'string' ? c.map.slice(0, 80) : undefined,
    kills: num(c.kills, 0, 99, 0),
    score: num(c.score, -1e6, 1e6, 0),
    tags: Array.isArray(c.tags) ? c.tags.filter((t: unknown) => typeof t === 'string').slice(0, 30) : [],
    durationSec: dur,
    width: num(c.width, 0, 10000, 0),
    height: num(c.height, 0, 10000, 0),
    fps: num(c.fps, 1, 480, 60),
    external: c.external === true || undefined,
    // Your own footage may not be Marvel Rivals, so it only gets the kill-feed box when asked.
    preserveKillFeed: c.external === true ? c.preserveKillFeed === true : c.preserveKillFeed !== false,
    // The game camera keeps your hero centred, so a centred crop is the default. Tracking is opt-in.
    followCharacter: c.followCharacter === true,
    feedRows: Array.isArray(c.feedRows) ? c.feedRows.filter((r: any) => r && [r.slot, r.from, r.to, r.x0].every((v) => typeof v === 'number' && Number.isFinite(v)) && r.slot >= 0 && r.slot < 6 && r.to > r.from).slice(0, 60).map((r: any) => ({ slot: Math.round(r.slot), from: r.from, to: r.to, x0: Math.min(1, Math.max(0, r.x0)) })) : undefined,
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
  const style = sanitizeStyle(p.style, getStyle(typeof p.style?.id === 'string' ? p.style.id : 'montage'));
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
    targetSeconds: Number.isFinite(p.targetSeconds) && p.targetSeconds >= 1 ? Math.min(f.maxSeconds, Number(p.targetSeconds)) : undefined,
    sourceWarnings: Array.isArray(p.sourceWarnings) ? p.sourceWarnings.filter((x:unknown):x is string=>typeof x==='string').slice(0,80).map((x:string)=>x.slice(0,500)) : [],
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
    assets: sanitizeAssets(p.assets),
    overlays: sanitizeOverlays(p.overlays),
    subtitles: sanitizeSubtitles(p.subtitles),
  };
}

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp)$/i;
const VIDEO_EXT = /\.(mp4|mov|mkv|webm|avi|m4v)$/i;

export function sanitizeAssets(raw: unknown): MediaAsset[] {
  if (!Array.isArray(raw)) return [];
  const out: MediaAsset[] = [];
  for (const a of raw.slice(0, 40)) {
    if (!a || typeof a.file !== 'string' || !path.isAbsolute(a.file)) continue;
    const kind = a.kind === 'image' && IMAGE_EXT.test(a.file) ? 'image' : a.kind === 'video' && VIDEO_EXT.test(a.file) ? 'video' : null;
    if (!kind) continue;
    out.push({
      id: typeof a.id === 'string' && /^[a-z0-9]{1,20}$/i.test(a.id) ? a.id : newId(),
      kind,
      file: a.file,
      name: String(a.name ?? path.basename(a.file)).slice(0, 120),
      durationSec: Number.isFinite(a.durationSec) ? num(a.durationSec, 0, 36000, 0) : undefined,
      width: Number.isFinite(a.width) ? num(a.width, 0, 20000, 0) : undefined,
      height: Number.isFinite(a.height) ? num(a.height, 0, 20000, 0) : undefined,
      hasAudio: a.hasAudio === undefined ? undefined : !!a.hasAudio,
    });
  }
  return out;
}

function frac(v: unknown, d: number): number {
  return num(v, 0, 1, d);
}

export function sanitizeOverlays(raw: unknown): ImageOverlay[] {
  if (!Array.isArray(raw)) return [];
  const out: ImageOverlay[] = [];
  for (const o of raw.slice(0, 40)) {
    if (!o || typeof o.image !== 'string' || !IMAGE_EXT.test(o.image) || typeof o.clipUid !== 'string') continue;
    const from = num(o.from, 0, 36000, 0);
    const to = num(o.to, from + 0.05, 36000, from + 3);
    const track = Array.isArray(o.track)
      ? o.track
          .filter((k: any) => k && [k.t, k.x, k.y, k.size].every(Number.isFinite))
          .slice(0, 400)
          .map((k: any) => ({ t: num(k.t, 0, 36000, 0), x: frac(k.x, 0.5), y: frac(k.y, 0.5), size: num(k.size, 0.02, 1, 0.15) }))
          .sort((a: OverlayKey, b: OverlayKey) => a.t - b.t)
      : undefined;
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id.slice(0, 40) : newId(),
      image: o.image,
      clipUid: o.clipUid.slice(0, 40),
      from,
      to,
      anchor: o.anchor === 'face' ? 'face' : 'fixed',
      x: frac(o.x, 0.5),
      y: frac(o.y, 0.4),
      size: num(o.size, 0.02, 1, 0.15),
      shape: o.shape === 'square' ? 'square' : 'circle',
      track: track && track.length ? track : undefined,
    });
  }
  return out;
}

export function sanitizeSubtitles(raw: unknown): ClipSubtitle[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s: any) => s && typeof s.text === 'string' && s.text.trim() && typeof s.clipUid === 'string')
    .slice(0, 200)
    .map((s: any) => {
      const from = num(s.from, 0, 36000, 0);
      return { clipUid: s.clipUid.slice(0, 40), from, to: num(s.to, from + 0.1, 36000, from + 2), text: String(s.text).replace(/\s+/g, ' ').trim().slice(0, 140) };
    });
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
