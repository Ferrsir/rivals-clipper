// Your music: files in <root>\music, an index (library.json) with each track's licence and beat analysis.
// Files you copy into the folder yourself are picked up too.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MusicLicense, MusicTrack } from '../../shared/studio';
import { ANALYSIS_RATE, analyzeSamples } from './beats';
import { decodeAudio, readTags } from './ffmpeg-bin';

export const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma', '.mp4', '.webm', '.mov'];

interface LibraryFile {
  version: 1;
  tracks: MusicTrack[];
}

export class MusicLibrary {
  private tracks: MusicTrack[] = [];
  private loaded = false;
  private analyzing = new Map<string, Promise<MusicTrack>>();

  constructor(
    private dir: string,
    private ffmpeg: () => Promise<string>,
  ) {}

  private get indexFile() {
    return path.join(this.dir, 'library.json');
  }

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) as LibraryFile;
      if (raw.version === 1 && Array.isArray(raw.tracks)) this.tracks = raw.tracks;
    } catch {
      this.tracks = [];
    }
  }

  private save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.indexFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, tracks: this.tracks } satisfies LibraryFile));
    fs.renameSync(tmp, this.indexFile);
  }

  /** All tracks; also notices files added to or removed from the folder by hand. */
  list(): MusicTrack[] {
    this.load();
    let changed = false;
    const known = new Set(this.tracks.map((t) => path.resolve(t.file).toLowerCase()));
    try {
      for (const name of fs.readdirSync(this.dir)) {
        const file = path.join(this.dir, name);
        if (!AUDIO_EXT.includes(path.extname(name).toLowerCase())) continue;
        if (known.has(path.resolve(file).toLowerCase())) continue;
        this.tracks.push(this.newTrack(file));
        changed = true;
      }
    } catch {
      /* folder missing */
    }
    const before = this.tracks.length;
    this.tracks = this.tracks.filter((t) => fs.existsSync(t.file));
    if (this.tracks.length !== before) changed = true;
    if (changed) this.save();
    return [...this.tracks].sort((a, b) => b.addedAt - a.addedAt);
  }

  get(id: string): MusicTrack | undefined {
    this.load();
    return this.tracks.find((t) => t.id === id);
  }

  private newTrack(file: string): MusicTrack {
    const base = path.basename(file).replace(/\.[^.]+$/, '');
    return { id: trackId(file), file, title: base.replace(/[_]+/g, ' ').trim(), addedAt: Date.now(), license: 'unknown', tags: [] };
  }

  /** Copy files into the music folder (unless they're already there) and analyse them. */
  async import(files: string[], onProgress?: (msg: string) => void): Promise<MusicTrack[]> {
    this.load();
    fs.mkdirSync(this.dir, { recursive: true });
    const added: MusicTrack[] = [];
    for (const src of files) {
      if (!AUDIO_EXT.includes(path.extname(src).toLowerCase())) continue;
      let dest = src;
      if (path.resolve(path.dirname(src)).toLowerCase() !== path.resolve(this.dir).toLowerCase()) {
        dest = uniquePath(path.join(this.dir, path.basename(src)));
        fs.copyFileSync(src, dest);
      }
      const existing = this.tracks.find((t) => path.resolve(t.file).toLowerCase() === path.resolve(dest).toLowerCase());
      const t = existing ?? this.newTrack(dest);
      if (!existing) this.tracks.push(t);
      try {
        const tags = await readTags(await this.ffmpeg(), dest);
        if (tags.title) t.title = tags.title;
        if (tags.artist) t.artist = tags.artist;
      } catch {
        /* tags are optional */
      }
      this.save();
      onProgress?.(`Finding the beat in ${t.title}`);
      added.push(await this.analyze(t.id));
    }
    return added;
  }

  async analyze(id: string, force = false): Promise<MusicTrack> {
    this.load();
    const t = this.tracks.find((x) => x.id === id);
    if (!t) throw new Error('Track not found');
    if (t.analysis && !force) return t;
    const running = this.analyzing.get(id);
    if (running) return running;
    const p = (async () => {
      try {
        const pcm = await decodeAudio(await this.ffmpeg(), t.file, ANALYSIS_RATE);
        if (pcm.length < ANALYSIS_RATE * 2) throw new Error('The file is shorter than 2 seconds.');
        t.analysis = analyzeSamples(pcm, ANALYSIS_RATE);
        delete t.analysisError;
      } catch (err) {
        t.analysisError = (err as Error).message.slice(0, 300);
      }
      this.save();
      return t;
    })();
    this.analyzing.set(id, p);
    try {
      return await p;
    } finally {
      this.analyzing.delete(id);
    }
  }

  /** Analyse anything not analysed yet, one at a time. */
  async analyzePending(onEach?: (t: MusicTrack) => void): Promise<void> {
    for (const t of this.list()) {
      if (t.analysis || t.analysisError) continue;
      onEach?.(await this.analyze(t.id));
    }
  }

  update(id: string, patch: Partial<Pick<MusicTrack, 'title' | 'artist' | 'license' | 'tags'>>): MusicTrack {
    this.load();
    const t = this.tracks.find((x) => x.id === id);
    if (!t) throw new Error('Track not found');
    if (typeof patch.title === 'string' && patch.title.trim()) t.title = patch.title.trim().slice(0, 120);
    if (typeof patch.artist === 'string') t.artist = patch.artist.trim().slice(0, 120) || undefined;
    if (patch.license && (['own', 'royalty-free', 'platform-only', 'unknown'] as MusicLicense[]).includes(patch.license)) t.license = patch.license;
    if (Array.isArray(patch.tags)) t.tags = patch.tags.filter((x) => typeof x === 'string').map((x) => x.slice(0, 30)).slice(0, 12);
    this.save();
    return t;
  }

  markUsed(id: string) {
    this.load();
    const t = this.tracks.find((x) => x.id === id);
    if (t) {
      t.lastUsedAt = Date.now();
      this.save();
    }
  }

  /** Remove from the library. The file is deleted only if it lives in the music folder. */
  remove(id: string, deleteFile: boolean): void {
    this.load();
    const t = this.tracks.find((x) => x.id === id);
    if (!t) return;
    this.tracks = this.tracks.filter((x) => x.id !== id);
    if (deleteFile && path.resolve(path.dirname(t.file)).toLowerCase() === path.resolve(this.dir).toLowerCase()) {
      fs.rmSync(t.file, { force: true });
    }
    this.save();
  }
}

function trackId(file: string): string {
  return crypto.createHash('sha1').update(path.resolve(file).toLowerCase()).digest('hex').slice(0, 12);
}

function uniquePath(p: string): string {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, -ext.length);
  for (let i = 2; ; i++) {
    const c = `${base} (${i})${ext}`;
    if (!fs.existsSync(c)) return c;
  }
}
