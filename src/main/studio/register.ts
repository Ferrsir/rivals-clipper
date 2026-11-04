// The Studio's main-process side: IPC handlers on "studio:*" channels (see docs/studio-interface.md).

import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AiClient } from '../ai-auth';
import { listClips } from '../clip-store';
import { Library, queryClips, type ClipQuery, type ClipSort } from '../library';
import { Settings, paths } from '../settings';
import type { ClipSidecar } from '../../shared/types';
import type { FormatId, FreeMedia, PublishPlatform, PublishRequest, ReelClip, ReelIdea, ReelProject, RenderRequest, StudioInit } from '../../shared/studio';
import { musicIdeas, pickClips, postCaption, tweakStyle, writeCaptions } from './ai';
import { findFfmpeg } from './ffmpeg-bin';
import { aiIdeas, quickIdeas } from './ideas';
import * as openverse from './openverse';
import { PublishService } from './publish';
import { Vault } from './publish/vault';
import { FORMATS, FORMAT_LIST, getFormat } from './formats';
import { MusicLibrary } from './music-library';
import { findFont, planFor, renderProject } from './pipeline';
import { createProject, newId, ProjectStore, reelClipFromSidecar, sanitizeProject } from './projects';
import { aiMusicPrompt, sourcesFor, suggestFromLibrary } from './suggest';
import { STYLES, clone, getStyle } from './styles';

export interface StudioContext {
  getSettings: () => Settings;
  ffmpegPath: () => string | undefined;
  ai?: AiClient;
}

export function registerStudio(ctx: StudioContext): void {
  const root = () => ctx.getSettings().rootFolder;
  const p = () => paths(root());
  const studioDir = () => path.join(root(), 'studio');
  const musicDir = () => path.join(root(), 'music');
  const defaultReelsDir = () => path.join(root(), 'exports', 'reels');
  // Studio's own preferences (the export folder), kept next to the projects.
  const prefsFile = () => path.join(studioDir(), 'prefs.json');
  const readPrefs = (): { exportDir?: string } => {
    try {
      const j = JSON.parse(fs.readFileSync(prefsFile(), 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch {
      return {};
    }
  };
  const writePrefs = (patch: { exportDir?: string }) => {
    fs.mkdirSync(studioDir(), { recursive: true });
    fs.writeFileSync(prefsFile(), JSON.stringify({ ...readPrefs(), ...patch }, null, 2));
  };
  /** Where exports go: the folder you picked, or <clips folder>\exports\reels. */
  const reelsDir = () => {
    const d = readPrefs().exportDir;
    return typeof d === 'string' && path.isAbsolute(d) ? d : defaultReelsDir();
  };

  const ffmpeg = async () => {
    const info = await findFfmpeg(ctx.ffmpegPath());
    if (!info.ok || !info.path) throw new Error(info.problem ?? 'ffmpeg not available');
    return info.path;
  };

  // Library and store follow the root folder if it changes.
  let lib: MusicLibrary | undefined;
  let libDir = '';
  const music = () => {
    if (!lib || libDir !== musicDir()) {
      libDir = musicDir();
      lib = new MusicLibrary(libDir, ffmpeg);
    }
    return lib;
  };
  const store = () => new ProjectStore(path.join(studioDir(), 'projects'));
  const analysisFor = (proj: ReelProject) => (proj.music ? music().get(proj.music.trackId)?.analysis ?? null : null);
  const inside = (dir: string, file: string) => {
    const rel = path.relative(path.resolve(dir), path.resolve(file));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  // Files the Studio may open or upload: under the clips folder or the export folder.
  const within = (file: string) => inside(root(), file) || inside(reelsDir(), file);

  const handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (e, ...args) => {
      try {
        return await fn(e, ...args);
      } catch (err) {
        // Electron strips custom error fields; keep the message readable.
        throw new Error((err as Error).message || String(err));
      }
    });
  };

  handle('studio:init', async (): Promise<StudioInit> => {
    const ff = await findFfmpeg(ctx.ffmpegPath());
    let ai = { signedIn: false, provider: 'none' };
    try {
      if (ctx.ai) ai = await ctx.ai.status();
    } catch {
      /* not signed in */
    }
    return {
      formats: FORMAT_LIST,
      styles: clone(STYLES),
      paths: { root: root(), studio: studioDir(), music: musicDir(), reels: reelsDir() },
      ffmpeg: { ok: ff.ok, path: ff.path, version: ff.version, gpuEncoders: ff.gpuEncoders, problem: ff.problem },
      ai,
    };
  });

  // ---------- clips ----------
  // The same index and filters as the Library screen, so both show the same clips.
  const clipIndex = new Library(() => p().clips);
  handle('studio:clips', () => {
    clipIndex.refresh();
    return queryClips(clipIndex.all(), { sort: 'new', limit: 5000 }).items.map((c) => ({ ...c, reel: reelClipFromSidecar(c) }));
  });
  handle('studio:clips:query', (_e, raw: unknown) => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : undefined);
    const num = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.min(99, Number(v)) : undefined);
    const sorts: ClipSort[] = ['new', 'score', 'kills', 'rating'];
    const q: ClipQuery = {
      text: str(r.text),
      hero: str(r.hero),
      map: str(r.map),
      gameType: str(r.gameType),
      minKills: num(r.minKills),
      minRating: num(r.minRating),
      sort: sorts.includes(r.sort as ClipSort) ? (r.sort as ClipSort) : 'score',
      limit: 5000,
    };
    clipIndex.refresh();
    const res = queryClips(clipIndex.all(), q);
    return { ids: res.items.map((c) => c.id), total: res.total };
  });
  handle('studio:clips:facets', () => clipIndex.facets());

  handle('studio:autoFill', (_e, proj: unknown, seconds: number) => {
    const project = sanitizeProject(proj);
    const used = new Set(project.clips.map((c) => c.videoFile));
    const pool = listClips(p().clips, 1000)
      .filter((c) => !used.has(c.videoFile) && fs.existsSync(c.videoFile))
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.score - a.score);
    const target = Math.max(5, Math.min(600, Number(seconds) || getFormat(project.format).idealSeconds[1]));
    const fmt = getFormat(project.format);
    const added: ReelClip[] = [];
    for (const c of pool) {
      const trial = { ...project, clips: [...project.clips, ...added, reelClipFromSidecar(c)] };
      const tl = planFor(trial, analysisFor(project), project.fps, fmt.maxSeconds);
      if (tl.duration > target * 1.1 && added.length) break;
      added.push(trial.clips[trial.clips.length - 1]);
      if (tl.duration >= target) break;
    }
    // Weakest first so the best one closes the reel.
    return added.sort((a, b) => a.score - b.score);
  });

  // ---------- projects ----------
  handle('studio:projects:list', () => store().list());
  handle('studio:projects:get', (_e, id: string) => store().get(id) ?? null);
  handle('studio:projects:create', (_e, opts: { name?: string; format?: FormatId; styleId?: string }) => store().save(createProject(opts ?? {})));
  handle('studio:projects:save', (_e, proj: unknown) => store().save(proj));
  handle('studio:projects:delete', (_e, id: string) => store().delete(id));
  handle('studio:projects:duplicate', (_e, id: string) => {
    const src = store().get(id);
    if (!src) throw new Error('Project not found');
    return store().save({ ...src, id: newId(), name: `${src.name} copy`, createdAt: Date.now(), lastExports: [] });
  });
  handle('studio:style', (_e, id: string) => getStyle(id));

  // ---------- planning ----------
  handle('studio:plan', (_e, proj: unknown) => {
    const project = sanitizeProject(proj);
    const fmt = getFormat(project.format);
    return planFor(project, analysisFor(project), project.fps, fmt.maxSeconds);
  });

  // ---------- rendering ----------
  const jobs = new Map<string, AbortController>();
  handle('studio:render', async (e, proj: unknown, req: RenderRequest) => {
    const project = sanitizeProject(proj);
    const jobId = newId();
    const ac = new AbortController();
    jobs.set(jobId, ac);
    const ff = await findFfmpeg(ctx.ffmpegPath());
    if (!ff.ok || !ff.path) throw new Error(ff.problem ?? 'ffmpeg not available');
    const formats = (Array.isArray(req?.formats) ? req.formats : [project.format]).filter((f): f is FormatId => f in FORMATS);
    const request: RenderRequest = { preview: !!req?.preview, formats, noMusicCopy: !!req?.noMusicCopy, gpu: !!req?.gpu };
    const enc = request.gpu && ff.gpuEncoders.length ? { name: ff.gpuEncoders[0] as 'h264_nvenc' } : { name: 'libx264' as const };
    const send = (msg: object) => {
      if (!e.sender.isDestroyed()) e.sender.send('studio:render:progress', { jobId, ...msg });
    };
    void (async () => {
      try {
        const files = await renderProject({
          ffmpeg: ff.path!,
          project,
          analysis: analysisFor(project),
          req: request,
          studioDir: studioDir(),
          reelsDir: reelsDir(),
          fontFile: findFont(),
          encoder: enc,
          onProgress: (pr) => send(pr),
          signal: ac.signal,
        });
        if (!request.preview) {
          if (project.music) music().markUsed(project.music.trackId);
          const saved = store().get(project.id);
          if (saved) store().save({ ...saved, lastExports: [...(saved.lastExports ?? []), ...files.map((f) => ({ file: f, format: guessFormat(f, formats), at: Date.now() }))] });
        }
        send({ stage: 'done', pct: 1, message: request.preview ? 'Preview ready' : `Saved ${files.length} file${files.length === 1 ? '' : 's'}`, files });
      } catch (err) {
        const msg = (err as Error).message;
        if (ac.signal.aborted) send({ stage: 'cancelled', pct: 0, message: 'Cancelled' });
        else send({ stage: 'error', pct: 0, message: 'Render failed', error: msg });
      } finally {
        jobs.delete(jobId);
      }
    })();
    return { jobId };
  });
  handle('studio:render:cancel', (_e, jobId: string) => jobs.get(jobId)?.abort());

  // ---------- music ----------
  handle('studio:music:list', () => music().list());
  handle('studio:music:import', async (e, files?: string[]) => {
    let list = Array.isArray(files) ? files.filter((f) => typeof f === 'string') : [];
    if (!list.length) {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      const r = await dialog.showOpenDialog(win!, {
        title: 'Add music',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'webm'] }],
      });
      if (r.canceled) return [];
      list = r.filePaths;
    }
    return music().import(list, (msg) => {
      if (!e.sender.isDestroyed()) e.sender.send('studio:music:progress', { message: msg });
    });
  });
  handle('studio:music:analyze', (_e, id: string) => music().analyze(id, true));
  handle('studio:music:analyzePending', async (e) => {
    await music().analyzePending((t) => {
      if (!e.sender.isDestroyed()) e.sender.send('studio:music:updated', t);
    });
    return music().list();
  });
  handle('studio:music:update', (_e, id: string, patch: object) => music().update(id, patch));
  handle('studio:music:remove', (_e, id: string, deleteFile: boolean) => music().remove(id, !!deleteFile));
  handle('studio:music:suggest', (_e, proj: unknown) => {
    const project = sanitizeProject(proj);
    const fmt = getFormat(project.format);
    const tl = planFor(project, null, project.fps, fmt.maxSeconds);
    const seconds = Math.max(fmt.idealSeconds[0], tl.duration || fmt.idealSeconds[1]);
    return { ranked: suggestFromLibrary(music().list(), project.style, fmt, seconds), sources: sourcesFor(fmt, project.style), note: fmt.music.note, seconds };
  });
  handle('studio:music:aiIdeas', async (_e, proj: unknown) => {
    const project = sanitizeProject(proj);
    const fmt = getFormat(project.format);
    const tl = planFor(project, null, project.fps, fmt.maxSeconds);
    const prompt = aiMusicPrompt({
      format: fmt,
      style: project.style,
      reelSeconds: Math.max(fmt.idealSeconds[0], tl.duration),
      heroes: project.clips.map((c) => c.hero).filter((h): h is string => !!h),
      tags: project.clips.flatMap((c) => c.tags),
      library: music()
        .list()
        .map((t) => ({ title: t.title, artist: t.artist, bpm: t.analysis?.bpm })),
    });
    return musicIdeas(ctx.ai, prompt);
  });

  // ---------- AI ----------
  handle('studio:ai:status', async () => (ctx.ai ? ctx.ai.status() : { signedIn: false, provider: 'none' }));
  handle('studio:ai:tweakStyle', (_e, proj: unknown, request: string) => tweakStyle(ctx.ai, sanitizeProject(proj).style, String(request ?? '')));
  handle('studio:ai:captions', (_e, proj: unknown, request: string, lines: number) => writeCaptions(ctx.ai, sanitizeProject(proj), String(request ?? ''), Math.max(2, Math.min(20, Number(lines) || 6))));
  handle('studio:ai:postCaption', (_e, proj: unknown) => {
    const project = sanitizeProject(proj);
    return postCaption(ctx.ai, project, getFormat(project.format));
  });
  handle('studio:ai:pickClips', async (_e, proj: unknown, seconds: number) => {
    const project = sanitizeProject(proj);
    const fmt = getFormat(project.format);
    const all = listClips(p().clips, 1000).filter((c) => fs.existsSync(c.videoFile));
    const ids = await pickClips(ctx.ai, all, fmt, project.style.name, Number(seconds) || fmt.idealSeconds[1]);
    const byId = new Map<string, ClipSidecar>(all.map((c) => [c.id, c]));
    return ids.map((id) => reelClipFromSidecar(byId.get(id)!));
  });

  // ---------- ideas ----------
  const libraryClips = () => listClips(p().clips, 1000).filter((c) => fs.existsSync(c.videoFile));
  handle('studio:ideas:quick', (_e, format: FormatId) => quickIdeas(libraryClips(), music().list(), getFormat(format)));
  handle('studio:ideas:ai', (_e, format: FormatId, request: string) =>
    aiIdeas(ctx.ai, { clips: libraryClips(), tracks: music().list(), format: getFormat(format), request: String(request ?? '').slice(0, 400), count: 5 }),
  );
  handle('studio:ideas:apply', (_e, idea: ReelIdea) => {
    if (!idea || typeof idea !== 'object' || !Array.isArray(idea.clipIds)) throw new Error('Not an idea');
    const byId = new Map<string, ClipSidecar>(libraryClips().map((c) => [c.id, c]));
    const clips = idea.clipIds.map((id) => byId.get(id)).filter((c): c is ClipSidecar => !!c).map(reelClipFromSidecar);
    if (!clips.length) throw new Error('The clips for this idea are no longer in your library.');
    const fmt = getFormat(idea.format);
    const proj = createProject({ name: String(idea.title ?? 'Reel idea').slice(0, 60), format: fmt.id, styleId: idea.styleId });
    proj.clips = clips;
    proj.order = 'manual';
    proj.captions = (Array.isArray(idea.captions) ? idea.captions : []).filter((x) => typeof x === 'string' && x.trim()).slice(0, 14).map((text) => ({ text }));
    proj.intro = typeof idea.hook === 'string' && idea.hook.trim() ? { text: idea.hook.trim().slice(0, 120), seconds: 4 } : null;
    if (typeof idea.postCaption === 'string') proj.caption = idea.postCaption.slice(0, 2200);
    const t = idea.music?.trackId ? music().get(idea.music.trackId) : undefined;
    if (t) proj.music = { trackId: t.id, file: t.file, title: t.title, start: 'auto' };
    return store().save(proj);
  });

  // ---------- royalty-free music and pictures ----------
  const imagesDir = () => path.join(studioDir(), 'images');
  handle('studio:free:search', (_e, kind: 'audio' | 'image', q: string) => openverse.search(kind === 'image' ? 'image' : 'audio', String(q ?? ''), { pageSize: 20, minSeconds: kind === 'image' ? undefined : 20 }));
  const freeItem = (m: FreeMedia, kind: FreeMedia['kind']): FreeMedia => {
    if (!m || typeof m !== 'object' || typeof m.url !== 'string' || !/^https:\/\//i.test(m.url)) throw new Error('Not a download');
    return { ...m, kind, credit: openverse.creditFor(m) };
  };
  handle('studio:free:downloadMusic', async (e, item: FreeMedia) => {
    const m = freeItem(item, 'audio');
    if (!e.sender.isDestroyed()) e.sender.send('studio:music:progress', { message: `Downloading ${m.title}` });
    const file = await openverse.download(m, musicDir());
    return music().addDownloaded(file, { title: m.title, artist: m.creator, credit: m.credit, sourceUrl: m.landingUrl ?? m.url, tags: ['free', m.license] });
  });
  handle('studio:free:downloadImage', async (_e, item: FreeMedia) => {
    const m = freeItem(item, 'image');
    const file = await openverse.download(m, imagesDir());
    return { file, credit: m.credit };
  });

  // ---------- publishing ----------
  const vault = new Vault(path.join(app.getPath('userData'), 'studio-accounts.bin'), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (t) => safeStorage.encryptString(t),
    decrypt: (b) => safeStorage.decryptString(b),
  });
  const publisher = new PublishService({
    vault,
    openBrowser: (url) => void shell.openExternal(url),
    loginWindow: (url, isDone) =>
      new Promise((resolve, reject) => {
        const win = new BrowserWindow({ width: 520, height: 720, title: 'Connect Instagram', autoHideMenuBar: true, webPreferences: { partition: 'persist:studio-meta-login', sandbox: true } });
        let finished = false;
        const check = (u: string) => {
          if (finished || !isDone(u)) return;
          finished = true;
          resolve(u);
          win.close();
        };
        win.webContents.on('will-redirect', (_ev, u) => check(u));
        win.webContents.on('did-navigate', (_ev, u) => check(u));
        win.webContents.on('did-redirect-navigation', (_ev, u) => check(u));
        win.on('closed', () => !finished && reject(new Error('Sign-in window was closed.')));
        void win.loadURL(url);
      }),
  });
  const platformOf = (x: unknown): PublishPlatform => {
    if (x === 'youtube' || x === 'tiktok' || x === 'instagram') return x;
    throw new Error('Unknown platform');
  };
  handle('studio:publish:status', () => publisher.status());
  handle('studio:publish:configure', (_e, pl: string, cfg: object) => publisher.configure(platformOf(pl), (cfg ?? {}) as never));
  handle('studio:publish:connect', (_e, pl: string) => publisher.connect(platformOf(pl)));
  handle('studio:publish:disconnect', (_e, pl: string, forget: boolean) => publisher.disconnect(platformOf(pl), !!forget));
  handle('studio:publish:upload', (e, req: PublishRequest) => {
    const platform = platformOf(req?.platform);
    const file = String(req?.file ?? '');
    if (!within(file) || !/\.mp4$/i.test(file)) throw new Error('Only exported reels can be uploaded.');
    const clean: PublishRequest = {
      platform,
      file,
      title: String(req.title ?? '').slice(0, 200),
      description: String(req.description ?? '').slice(0, 5000),
      tags: (Array.isArray(req.tags) ? req.tags : []).filter((t) => typeof t === 'string').slice(0, 30),
      privacy: req.privacy === 'private' || req.privacy === 'unlisted' ? req.privacy : 'public',
      shorts: !!req.shorts,
    };
    const uploadId = newId();
    const send = (msg: object) => {
      if (!e.sender.isDestroyed()) e.sender.send('studio:publish:progress', { uploadId, platform, ...msg });
    };
    void (async () => {
      send({ stage: 'uploading', pct: 0, message: 'Starting upload' });
      try {
        const r = await publisher.upload(clean, (pr) => send(pr));
        send({ stage: 'done', pct: 1, message: r.message, url: r.url });
      } catch (err) {
        send({ stage: 'error', pct: 0, message: 'Upload failed', error: (err as Error).message });
      }
    })();
    return { uploadId };
  });

  // ---------- files ----------
  handle('studio:pickImage', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const r = await dialog.showOpenDialog(win!, { title: 'Intro image', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }] });
    return r.canceled ? undefined : r.filePaths[0];
  });
  handle('studio:show', (_e, file: string) => {
    if (typeof file === 'string' && fs.existsSync(file)) shell.showItemInFolder(file);
  });
  handle('studio:open', (_e, file: string) => {
    if (typeof file === 'string' && within(file) && fs.existsSync(file)) return shell.openPath(file);
  });
  handle('studio:openFolder', (_e, which: 'reels' | 'music') => {
    const dir = which === 'music' ? musicDir() : reelsDir();
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });
  handle('studio:exportDir:choose', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const r = await dialog.showOpenDialog(win!, { title: 'Save reels to', defaultPath: reelsDir(), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return reelsDir();
    fs.mkdirSync(r.filePaths[0], { recursive: true });
    writePrefs({ exportDir: r.filePaths[0] });
    return reelsDir();
  });
  handle('studio:exportDir:reset', () => {
    writePrefs({ exportDir: undefined });
    return reelsDir();
  });
  handle('studio:openExternal', (_e, url: string) => {
    if (typeof url === 'string' && /^https:\/\/[^\s]+$/i.test(url)) return shell.openExternal(url);
  });
}

function guessFormat(file: string, formats: FormatId[]): FormatId {
  const m = path.basename(file).match(/_(tiktok|reels|shorts|youtube1440|youtube)(?:_nomusic)?\.mp4$/);
  return (m?.[1] as FormatId) ?? formats[0];
}
