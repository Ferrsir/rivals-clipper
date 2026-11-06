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
import { reviseReel, musicIdeas, pickClips, postCaption, tweakStyle, writeCaptions } from './ai';
import { findFfmpeg } from './ffmpeg-bin';
import { aiIdeas, quickIdeas } from './ideas';
import * as openverse from './openverse';
import { PublishService } from './publish';
import { Vault } from './publish/vault';
import { FORMATS, FORMAT_LIST, getFormat } from './formats';
import { MusicLibrary } from './music-library';
import { findFont, planFor, renderProject } from './pipeline';
import { createProject, newId, ProjectStore, projectFromIdea, reelClipFromSidecar, sanitizeAssets, sanitizeProject, reconcileProjectSources } from './projects';
import { describeFit, duration as reelSeconds, fitToTarget, requestedSeconds } from './fit';
import { locateFace } from './overlay';
import { scanClip, trimAround, type ClipScan } from './clip-filter';
import { withFeedRows } from './feed-rows';
import { findSong, readIntent } from './intent';
import { detectMoments, expandOwnFootage } from './moments';
import { SpeechTools } from './tools';
import { assignSpeakers, linesToSubtitles, transcribe } from './speech';
import { aiCast, autoCast, localSynth } from './voices';
import { IMAGE_EXTS, VIDEO_EXTS, importAssets } from './assets';
import { reviewRenderedReel } from './review';
import { aiMusicPrompt, sourcesFor, suggestFromLibrary } from './suggest';
import { STYLES, clone, getStyle } from './styles';

export interface StudioContext {
  getSettings: () => Settings;
  ffmpegPath: () => string | undefined;
  ai?: AiClient;
}

export function registerStudio(ctx: StudioContext): () => Promise<void> {
  let closing = false;
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
        if (closing) throw new Error('The app is closing');
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
    const project = reconcileProjectSources(sanitizeProject(proj), listClips(p().clips, 1000));
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
  handle('studio:projects:get', (_e, id: string) => { const project=store().get(id); return project ? reconcileProjectSources(project,listClips(p().clips,1000)) : null; });
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
    const project = reconcileProjectSources(sanitizeProject(proj), listClips(p().clips, 1000));
    const fmt = getFormat(project.format);
    return planFor(project, analysisFor(project), project.fps, fmt.maxSeconds);
  });

  // ---------- rendering ----------
  const jobs = new Map<string, { abort: () => void; done: Promise<void> }>();
  handle('studio:render', async (e, proj: unknown, req: RenderRequest) => {
    const project = reconcileProjectSources(sanitizeProject(proj), listClips(p().clips, 1000));
    const jobId = newId();
    const ac = new AbortController();
    const ff = await findFfmpeg(ctx.ffmpegPath());
    if (!ff.ok || !ff.path) throw new Error(ff.problem ?? 'ffmpeg not available');
    if (closing) throw new Error('The app is closing');
    const formats = (Array.isArray(req?.formats) ? req.formats : [project.format]).filter((f): f is FormatId => f in FORMATS);
    const request: RenderRequest = { preview: !!req?.preview, formats, noMusicCopy: !!req?.noMusicCopy, gpu: !!req?.gpu };
    const enc = request.gpu && ff.gpuEncoders.length ? { name: ff.gpuEncoders[0] as 'h264_nvenc' } : { name: 'libx264' as const };
    const send = (msg: object) => {
      if (!e.sender.isDestroyed()) e.sender.send('studio:render:progress', { jobId, ...msg });
    };
    const done = (async () => {
      try {
        const files = await renderProject({
          ffmpeg: ff.path!,
          project,
          analysis: analysisFor(project),
          ai: ctx.ai,
          req: request,
          studioDir: studioDir(),
          reelsDir: reelsDir(),
          fontFile: findFont(),
          encoder: enc,
          onProgress: (pr) => send(pr),
          signal: ac.signal,
          synth: project.voices?.on ? localSynth({ ffmpeg: ff.path!, tools: speechTools(), progress: (m, pct) => send({ stage: 'assemble', pct: pct ?? 0.99, message: m }) }) : undefined,
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
    jobs.set(jobId, { abort: () => ac.abort(), done });
    void done.catch(() => undefined); // shutdown still observes unexpected failures through the stored promise
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
    const project = reconcileProjectSources(sanitizeProject(proj), listClips(p().clips, 1000));
    const fmt = getFormat(project.format);
    const tl = planFor(project, null, project.fps, fmt.maxSeconds);
    const seconds = Math.max(fmt.idealSeconds[0], tl.duration || fmt.idealSeconds[1]);
    return { ranked: suggestFromLibrary(music().list(), project.style, fmt, seconds), sources: sourcesFor(fmt, project.style), note: fmt.music.note, seconds };
  });
  handle('studio:music:aiIdeas', async (_e, proj: unknown) => {
    const project = reconcileProjectSources(sanitizeProject(proj), listClips(p().clips, 1000));
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
  handle('studio:ai:reviseReel', async (_e, proj: unknown, request: string, assets?: unknown) => {
    const text = String(request ?? '');
    const current = reconcileProjectSources(sanitizeProject(proj), listClips(p().clips, 1000));
    const extra = sanitizeAssets(assets).filter(a => fs.existsSync(a.file) && !(current.assets ?? []).some(b => b.file === a.file));
    current.assets = [...(current.assets ?? []), ...extra];
    const revised = await reviseReel(ctx.ai, current, text, libraryClips());
    const { project, notes } = await finishPlan(revised.project, text);
    return { project, summary: [revised.summary, ...notes].join(' ') };
  });
  handle('studio:ai:reviewReel', async (_e, proj: unknown, file: string, request: string) => {
    if (typeof file !== 'string' || !within(file) || !fs.existsSync(file) || !/\.mp4$/i.test(file)) throw new Error('Select an existing rendered reel inside your clips or export folder.');
    const project = reconcileProjectSources(sanitizeProject(proj), listClips(p().clips, 1000));
    return reviewRenderedReel({ ai:ctx.ai, ffmpeg:await ffmpeg(), file, project, analysis:analysisFor(project), request:String(request ?? ''), reviewDir:path.join(studioDir(), 'reviews'), referenceImages:['style-feed.jpg','style-gameplay.jpg'].map(name=>path.join(studioDir(),'references',name)) });
  });
  handle('studio:ai:status', async () => (ctx.ai ? ctx.ai.status() : { signedIn: false, provider: 'none' }));
  handle('studio:ai:tweakStyle', (_e, proj: unknown, request: string) => tweakStyle(ctx.ai, sanitizeProject(proj).style, String(request ?? '')));
  handle('studio:ai:captions', (_e, proj: unknown, request: string, lines: number) => writeCaptions(ctx.ai, sanitizeProject(proj), String(request ?? ''), Math.max(2, Math.min(20, Number(lines) || 6))));
  handle('studio:ai:postCaption', (_e, proj: unknown) => {
    const project = reconcileProjectSources(sanitizeProject(proj), listClips(p().clips, 1000));
    return postCaption(ctx.ai, project, getFormat(project.format));
  });
  handle('studio:ai:pickClips', async (_e, proj: unknown, seconds: number) => {
    const project = reconcileProjectSources(sanitizeProject(proj), listClips(p().clips, 1000));
    const fmt = getFormat(project.format);
    const all = listClips(p().clips, 1000).filter((c) => fs.existsSync(c.videoFile));
    const ids = await pickClips(ctx.ai, all, fmt, project.style.name, Number(seconds) || fmt.idealSeconds[1]);
    const byId = new Map<string, ClipSidecar>(all.map((c) => [c.id, c]));
    return ids.map((id) => reelClipFromSidecar(byId.get(id)!));
  });

  // ---------- ideas ----------
  const libraryClips = () => listClips(p().clips, 1000).filter((c) => fs.existsSync(c.videoFile));
  handle('studio:ideas:quick', (_e, format: FormatId) => quickIdeas(libraryClips(), music().list(), getFormat(format)));
  handle('studio:ideas:ai', async (_e, format: FormatId, request: string, count?:number, assets?: unknown) => {
    const ff = await ffmpeg();
    const own = sanitizeAssets(assets).filter(a => fs.existsSync(a.file));
    // Videos added before moment detection existed get their action moments now.
    for (const a of own) if (a.kind === 'video' && a.moments === undefined && a.durationSec) a.moments = await detectMoments(ff, a.file, a.durationSec, a.hasAudio !== false);
    return aiIdeas(ctx.ai, { clips: libraryClips(), tracks: music().list(), format: getFormat(format), request: String(request ?? ''), count:count===1 ? 1 : 5, ffmpeg:ff, assets: own });
  });
  /**
   * Everything after the AI's plan that makes it a finished edit: a song from your library when none was
   * picked, the length you asked for (pulling in more kill clips or dropping weak ones), and faces located
   * for picture overlays. Returns notes for the "current step" display.
   */
  const speechTools = () => new SpeechTools(path.join(studioDir(), 'tools'));
  /**
   * "make them have subtitles": what's said in the clips, as English lines, with who says each one
   * (from the AI). "ai voices for them talking": a voice per character reads those lines.
   */
  const addSpeech = async (project: ReelProject, request: string, wantSubs: boolean, wantVoices: boolean, notes: string[], signal?: AbortSignal) => {
    const ff = await ffmpeg();
    const keepLanguage = /\b(original|japanese|native) (language|audio|subtitles?|subs)\b|\bdon'?t translate\b/i.test(request);
    if (wantSubs || wantVoices) {
      // Only transcribe when the plan has no lines of its own (your words win).
      const sources = [...new Set(project.clips.map(c => c.videoFile))].filter(file => !(project.subtitles ?? []).some(t => project.clips.find(c => c.uid === t.clipUid)?.videoFile === file));
      let whisper: { bin: string; model: string } | undefined;
      for (const file of sources) {
        const used = project.clips.filter(c => c.videoFile === file);
        const from = Math.max(0, Math.min(...used.map(c => c.in)) - 0.5);
        const to = Math.max(...used.map(c => c.out)) + 0.5;
        try {
          whisper ??= await speechTools().whisper(undefined, 'small', signal);
          const heard = await transcribe({ ffmpeg: ff, whisper, clip: used[0], from, to, keepLanguage, signal });
          let lines = heard.lines;
          if (lines.length && ctx.ai) lines = await assignSpeakers({ ai: ctx.ai, ffmpeg: ff, clip: used[0], lines, request, signal }).catch(() => lines);
          if (!lines.length) continue;
          project.subtitles = [...(project.subtitles ?? []), ...linesToSubtitles(lines, project.clips, file)];
          notes.push(`Subtitled ${lines.length} spoken line${lines.length === 1 ? '' : 's'}${heard.language && heard.language !== 'en' && !keepLanguage ? ` (translated from ${heard.language})` : ''}.`);
        } catch (error) {
          notes.push(`Couldn't make subtitles (${(error as Error).message}).`);
          break;
        }
      }
      if (!(project.subtitles ?? []).length) notes.push('No speech was found for subtitles. Write the lines in your prompt (e.g. Gojo: "Throughout heaven and earth...") and they will be used.');
    }
    if (wantVoices) {
      // Lines you wrote without a speaker are read by one voice.
      project.subtitles = (project.subtitles ?? []).map(t => (t.speaker ? t : { ...t, speaker: 'Narrator' }));
      const speakers = [...new Set(project.subtitles.map(t => t.speaker!))];
      if (speakers.length) {
        const cast = ctx.ai ? await aiCast(ctx.ai, speakers, request) : autoCast(speakers, project.voices?.cast);
        project.voices = { on: true, cast, duck: project.voices?.duck ?? 0.25, volume: project.voices?.volume ?? 1.1 };
        notes.push(`AI voices: ${cast.map(r => `${r.speaker} (${r.voice.replace(/^piper:[a-z]{2}_[A-Z]{2}-/, '').replace(/-\w+$/, '')})`).join(', ')}. They're made on your PC with Piper; the first render downloads each voice once.`);
      }
    }
  };
  const finishPlan = async (project: ReelProject, request: string, signal?: AbortSignal): Promise<{ project: ReelProject; notes: string[] }> => {
    const notes: string[] = [];
    const fmt = getFormat(project.format);
    const intent = readIntent(request);
    const target = intent.seconds ?? project.targetSeconds ?? 30;
    project.targetSeconds = target;
    // "to the song aizo": the song you named, from your music folder, wins over the AI's pick.
    if (intent.song) {
      const named = findSong(music().list(), intent.song);
      if (named) {
        const track = named.analysis ? named : await music().analyze(named.id).catch(() => named);
        if (project.music?.trackId !== track.id) project.music = { trackId: track.id, file: track.file, title: track.title, start: 'auto' };
        notes.push(`Using "${track.title}"${track.analysis ? ` (${Math.round(track.analysis.bpm)} BPM), cut on its beats with the biggest hit on the drop` : ''}.`);
      } else {
        notes.push(`"${intent.song}" isn't in your music yet. Add the song file under Music (or drop it in your music folder) and make the reel again to cut it to that song.`);
      }
    }
    // Your own footage, from any game or show: long videos become excerpts around their best action.
    const ownOnly = project.clips.length > 0 && project.clips.every(c => c.external);
    if (ownOnly) {
      const ex = expandOwnFootage(project, target);
      project = ex.project;
      if (ex.expanded) notes.push(`Cut your footage into ${project.clips.length} excerpts around its biggest moments.`);
    }
    if (!project.music) {
      const best = suggestFromLibrary(music().list(), project.style, fmt, target)[0];
      const track = best && music().get(best.trackId);
      if (track && track.analysis) {
        project.music = { trackId: track.id, file: track.file, title: track.title, start: 'auto' };
        notes.push(`Picked "${track.title}" from your music (${Math.round(track.analysis.bpm)} BPM).`);
      }
    }
    // Never use footage with the Tab scoreboard up: trim around it, or drop the clip.
    const ff0 = await ffmpeg();
    // Never pull Marvel Rivals library clips into an edit of your own footage.
    const pool = ownOnly ? [] : libraryClips().filter(c => c.events.some(e => e.type === 'kill')).sort((a, b) => b.score - a.score).slice(0, 60);
    const scans = new Map<string, ClipScan>();
    for (const file of new Set([...project.clips.filter(c => !c.external).map(c => c.videoFile), ...pool.map(c => c.videoFile)])) scans.set(file, await scanClip(ff0, file, signal));
    // Kill times from when your row appears in the feed (dropping teammates' kills), then trim off the scoreboard.
    // If no scanned clip shows a single row of yours, the feed is somewhere this build doesn't look
    // (another HUD scale or layout): keep the clipper's kills rather than throw everything away.
    const feedReadable = [...scans.values()].some(s => s.feed.some(f => f.own.some(x => x != null)));
    const prepare = (c: ReelClip) => {
      if (c.external) return c;
      const scan = scans.get(c.videoFile);
      const own = scan && feedReadable ? withFeedRows(c, scan.feed) : c;
      // Not your kill, or it opens straight on the kill with no build-up: leave it out.
      const first = own.hits.find(h => h > own.in);
      if (first === undefined || first - own.in < 1) return null;
      return trimAround(own, scan?.scoreboard ?? []);
    };
    const before = project.clips.length;
    project.clips = project.clips.map(prepare).filter((c): c is ReelClip => !!c);
    const dropped = before - project.clips.length;
    if (!project.clips.length) {
      // Every pick had the scoreboard open: start from the best usable kill clip so fitting can fill the rest.
      for (const source of pool) {
        const c = fs.existsSync(source.videoFile) ? prepare(reelClipFromSidecar(source)) : null;
        if (c) { project.clips = [c]; break; }
      }
    }
    if (dropped) notes.push(`Left out ${dropped} clip${dropped === 1 ? '' : 's'} with the scoreboard open.`);
    const fit = fitToTarget(project, pool, analysisFor(project), ownOnly ? { maxAdd: 0 } : { prepare });
    project = fit.project;
    const fitNote = describeFit(fit, target);
    if (fitNote) notes.push(fitNote.charAt(0).toUpperCase() + fitNote.slice(1));
    // "start the song at 0:56" / "end the song at 1:12": put the reel on the part of the song you want.
    if (project.music && (intent.songStart !== undefined || intent.songEnd !== undefined)) {
      // A new start moves the beat grid, which can change the reel's length: settle the end by replanning.
      let length = fit.seconds;
      let start = intent.songStart ?? Math.max(0, intent.songEnd! - length);
      for (let i = 0; i < 4; i++) {
        project.music = { ...project.music, start };
        length = reelSeconds(project, analysisFor(project));
        if (intent.songStart !== undefined) break;
        const next = Math.max(0, intent.songEnd! - length);
        if (Math.abs(next - start) < 0.02) break;
        start = next;
      }
      const at = (v: number) => `${Math.floor(v / 60)}:${(v % 60).toFixed(1).padStart(4, '0')}`;
      notes.push(`The song plays from ${at(start)} to ${at(start + length)}.`);
    }
    if (fit.seconds < target - 3) notes.push(ownOnly ? `Your footage gives about ${Math.round(fit.seconds)} s of action; add another clip for a longer reel.` : `You only have enough kill clips for about ${Math.round(fit.seconds)} s right now.`);
    const faces = (project.overlays ?? []).filter(o => o.anchor === 'face' && !o.track?.length);
    if (faces.length && ctx.ai) {
      const ff = await ffmpeg();
      // One search per picture and moment, shared by every excerpt cut from the same video.
      const found = new Map<string, Awaited<ReturnType<typeof locateFace>>>();
      let ok = 0;
      let failed = '';
      for (const ov of faces) {
        const clip = project.clips.find(c => c.uid === ov.clipUid);
        if (!clip) continue;
        // Only the part of the clip that is used, so the AI looks closely where it matters.
        const from = Math.max(ov.from, clip.in);
        const to = Math.min(ov.to, clip.out);
        if (to - from < 0.1) continue;
        const key = [clip.videoFile, ov.image, from, to].join('|');
        try {
          if (!found.has(key)) found.set(key, await locateFace(ff, ctx.ai, clip, { ...ov, from, to }, request.slice(0, 400), signal));
          ov.track = found.get(key);
          ok++;
        } catch (error) {
          failed = (error as Error).message;
        }
      }
      if (ok) notes.push('Found the face for your picture overlay.');
      if (failed) notes.push(`Couldn't find the face for your picture (${failed}); it sits where the AI first placed it.`);
    }
    if (intent.subtitles || intent.voices) await addSpeech(project, request, intent.subtitles, intent.voices, notes, signal);
    if (intent.faceOverlay && !(project.overlays ?? []).length) notes.push(!(project.assets ?? []).some(a => a.kind === 'image') ? 'Add the picture you want on their face (drop it in with your clip) and make the reel again.' : "The AI didn't place your picture; try naming who it goes on, e.g. \"put the Deadpool icon on Gojo's face\".");
    return { project, notes };
  };
  handle('studio:ideas:apply', async (_e, idea: ReelIdea, request?: string) => {
    const built = projectFromIdea(idea, libraryClips(), music().list());
    const { project, notes } = await finishPlan(built, String(request ?? ''));
    return { ...store().save(project), buildNotes: notes };
  });
  handle('studio:assets:pick', async (e, kind?: 'video' | 'image' | 'any') => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const filters = kind === 'image' ? [{ name: 'Pictures', extensions: IMAGE_EXTS }] : kind === 'video' ? [{ name: 'Videos', extensions: VIDEO_EXTS }] : [{ name: 'Videos and pictures', extensions: [...VIDEO_EXTS, ...IMAGE_EXTS] }];
    const r = await dialog.showOpenDialog(win!, { title: 'Add your clips or pictures', properties: ['openFile', 'multiSelections'], filters });
    return r.canceled ? [] : importAssets(await ffmpeg(), r.filePaths);
  });
  handle('studio:assets:import', async (_e, files: unknown) =>
    importAssets(await ffmpeg(), (Array.isArray(files) ? files : []).filter((f): f is string => typeof f === 'string' && path.isAbsolute(f) && fs.existsSync(f))),
  );

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
  return async () => {
    closing = true;
    const active = [...jobs.values()];
    for (const job of active) job.abort();
    await Promise.allSettled(active.map(job => job.done));
  };
}

function guessFormat(file: string, formats: FormatId[]): FormatId {
  const m = path.basename(file).match(/_(tiktok|reels|shorts|youtube1440|youtube)(?:_nomusic)?\.mp4$/);
  return (m?.[1] as FormatId) ?? formats[0];
}
