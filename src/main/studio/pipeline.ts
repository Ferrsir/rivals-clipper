import { trackClip } from './tracking';
import type { AiClient } from '../ai-auth';
// Runs a whole export: plan per frame rate, stage A per clip (cached), stage B per output size,
// then copies for platforms that share a size and optional no-music copies.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { audioStreamCount } from '../audio-streams';
import type { ExportFormat, FormatId, MusicAnalysis, ReelProject, RenderProgress, RenderRequest, Timeline } from '../../shared/studio';
import { FORMATS } from './formats';
import { orderClips, plan } from './planner';
import { EncoderChoice, FfJob, Size, buildAssembleJob, buildClipJob, buildIntroJob, hashOf } from './render';

export interface PipelineOpts {
  ffmpeg: string;
  project: ReelProject;
  analysis: MusicAnalysis | null;
  ai?: AiClient;
  req: RenderRequest;
  /** <root>\studio */
  studioDir: string;
  /** <root>\exports\reels */
  reelsDir: string;
  fontFile?: string;
  encoder: EncoderChoice;
  onProgress: (p: Omit<RenderProgress, 'jobId'>) => void;
  signal?: AbortSignal;
}

export function outputFps(project: ReelProject, f: ExportFormat, preview: boolean): number {
  if (preview) return 30;
  const fps = f.id === project.format ? project.fps : f.fps;
  return f.fpsOptions.includes(fps) ? fps : f.fps;
}

export function outputSize(f: ExportFormat, preview: boolean): Size {
  if (!preview) return { width: f.width, height: f.height };
  const even = (v: number) => Math.round(v / 4) * 2;
  return { width: even(f.width), height: even(f.height) };
}

export function planFor(project: ReelProject, analysis: MusicAnalysis | null, fps: number, maxSeconds?: number): Timeline {
  const clips = orderClips(project.clips, project.order);
  const timeline = plan({
    clips,
    style: project.style,
    fps,
    analysis: project.music ? analysis : null,
    musicStart: project.music?.start ?? 'auto',
    heroUid: project.heroUid,
    intro: project.intro,
    captions: project.captions,
    maxSeconds,
    targetSeconds: project.targetSeconds,
  });
  timeline.warnings.push(...(project.sourceWarnings ?? []));
  timeline.captions.push(...subtitleTimes(project, timeline));
  timeline.captions.sort((a, b) => a.start - b.start);
  return timeline;
}

/** Map subtitles from clip seconds to reel seconds through the retimed segments. Parts cut from the edit are dropped. */
export function subtitleTimes(project: ReelProject, tl: Timeline): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  const toOut = (uid: string, t: number): number | undefined => {
    const seg = tl.segments.find((s) => s.clipUid === uid && t >= s.src[0] - 1e-4 && t <= s.src[1] + 1e-4);
    return seg ? seg.out[0] + (t - seg.src[0]) / Math.max(1e-3, seg.speed) : undefined;
  };
  for (const sub of project.subtitles ?? []) {
    const segs = tl.segments.filter((s) => s.clipUid === sub.clipUid);
    if (!segs.length) continue;
    const from = Math.max(sub.from, segs[0].src[0]);
    const to = Math.min(sub.to, segs[segs.length - 1].src[1]);
    if (to - from < 0.1) continue;
    const start = toOut(sub.clipUid, from);
    const end = toOut(sub.clipUid, to);
    if (start === undefined || end === undefined || end - start < 0.1) continue;
    out.push({ text: sub.text, start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 });
  }
  return out;
}

export function safeName(s: string): string {
  return (s || 'reel').replace(/[^a-z0-9 _-]+/gi, '').trim().replace(/\s+/g, '-').slice(0, 50) || 'reel';
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

/** One base name per export, shared by its format variants, that no earlier export in `dir` already uses. */
export function uniqueExportBase(dir: string, name: string, d = new Date()): string {
  const root = `${safeName(name)}_${stamp(d)}`;
  const taken = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  const used = (b: string) => [...taken].some((f) => f.startsWith(`${b}_`));
  if (!used(root)) return root;
  for (let n = 2; ; n++) if (!used(`${root}-${n}`)) return `${root}-${n}`;
}

const graphFileOptions = new Map<string, string>();

export function runFfmpeg(ffmpeg: string, job: FfJob, cwd: string, onPct: (pct: number) => void, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('cancelled'));
  const script = path.join(cwd, `graph-${hashOf([job.output, job.filter]).slice(0, 10)}.txt`);
  fs.writeFileSync(script, job.filter, 'utf8');
  const graphOption = graphFileOptions.get(ffmpeg) ?? '-filter_complex_script';
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', graphOption, script, ...job.args];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { cwd, windowsHide: true });
    let err = '';
    let buf = '';
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort);
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const m = line.match(/^out_time_us=(\d+)/);
        if (m && job.duration > 0) onPct(Math.min(1, Number(m[1]) / 1e6 / job.duration));
      }
    });
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('cancelled'));
      // FFmpeg 9 removed the legacy option. Keep older bundled builds working,
      // and retry only this option-parsing failure, before any rendering began.
      if (code !== 0 && graphOption === '-filter_complex_script' && /Unrecognized option 'filter_complex_script'/.test(err)) {
        graphFileOptions.set(ffmpeg, '-/filter_complex');
        runFfmpeg(ffmpeg, job, cwd, onPct, signal).then(resolve, reject);
        return;
      }
      if (code === 0) {
        try {
          fs.rmSync(script, { force: true });
        } catch {
          /* ignore */
        }
        resolve();
      } else reject(new Error(err.trim().split('\n').slice(-6).join('\n') || `ffmpeg exited with ${code}`));
    });
  });
}

function runSimple(ffmpeg: string, args: string[], cwd: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('cancelled'));
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args], { cwd, windowsHide: true });
    let err = '';
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort);
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', code => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('cancelled'));
      code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exited with ${code}`));
    });
  });
}

/** Font for captions, copied next to the job so drawtext can use a plain relative name. */
export function findFont(): string | undefined {
  const win = process.env.WINDIR ?? 'C:\\Windows';
  const candidates = [
    path.join(win, 'Fonts', 'seguibl.ttf'),
    path.join(win, 'Fonts', 'segoeuib.ttf'),
    path.join(win, 'Fonts', 'arialbd.ttf'),
    path.join(win, 'Fonts', 'impact.ttf'),
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  ];
  return candidates.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

export async function renderProject(o: PipelineOpts): Promise<string[]> {
  if (o.signal?.aborted) throw new Error('cancelled');
  const req = o.req;
  const project = structuredClone(o.project);
  if (!project.clips.length) throw new Error('Add at least one clip first.');
  const formats = (req.formats.length ? req.formats : [project.format]).map((id) => FORMATS[id as FormatId]).filter(Boolean);
  const workDir = path.join(o.studioDir, 'cache', safeName(project.id));
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(o.reelsDir, { recursive: true });
  let font: string | undefined;
  if (o.fontFile && (project.captions.some((c) => c.text.trim()) || project.subtitles?.length || project.intro?.text || project.outro?.text)) {
    font = path.join(workDir, 'caption-font' + path.extname(o.fontFile));
    if (!fs.existsSync(font)) fs.copyFileSync(o.fontFile, font);
  }

  // Formats that share size and fps share one render.
  const groups = new Map<string, ExportFormat[]>();
  for (const f of req.preview ? formats.slice(0, 1) : formats) {
    const size = outputSize(f, req.preview);
    const key = `${size.width}x${size.height}@${outputFps(project, f, req.preview)}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }

  const files: string[] = [];
  const audioCounts = new Map<string, number>();
  for (const [index, clip] of project.clips.entries()) {
    // Marvel Rivals' third-person camera keeps your hero in the middle of the screen, so a centred crop
    // follows them. Frame-by-frame tracking is opt-in: it guesses wrong around big effects.
    if (clip.followCharacter === true && formats.some(format=>format.height>=format.width)) {
      o.onProgress({stage:'clips',pct:0,message:`Framing player ${index+1}/${project.clips.length}${o.ai ? ' with your AI provider' : ''}…`});
      clip.cropTrack = await trackClip(o.ffmpeg, clip, o.signal, o.ai);
    }
  }
  for (const clip of project.clips) {
    if (!audioCounts.has(clip.videoFile)) audioCounts.set(clip.videoFile, await audioStreamCount(o.ffmpeg, clip.videoFile, o.signal));
  }
  const base = req.preview ? '' : uniqueExportBase(o.reelsDir, project.name);
  let gi = 0;
  const totalGroups = groups.size;
  const report = (stage: RenderProgress['stage'], within: number, message: string) =>
    o.onProgress({ stage, pct: Math.min(0.999, (gi + within) / totalGroups), message });

  for (const fmts of groups.values()) {
    const f = fmts[0];
    const size = outputSize(f, req.preview);
    const fps = outputFps(project, f, req.preview);
    const tl = planFor(project, o.analysis, fps, f.maxSeconds);
    if (!tl.segments.length) throw new Error('Nothing to render: the clips have no usable footage.');
    const clips = orderClips(project.clips, project.order);
    const inputs: string[] = [];

    // ---- intro card ----
    const jobs: Array<{ job: FfJob; label: string }> = [];
    if (project.intro && tl.introEnd > 0) {
      let image = project.intro.image && fs.existsSync(project.intro.image) ? project.intro.image : '';
      let blurred = false;
      if (!image) {
        const first = tl.segments.find((s) => s.kind !== 'intro');
        const c = clips[first!.clipIndex];
        image = path.join(workDir, `introframe-${hashOf([c.videoFile, first!.src[0]])}.jpg`);
        if (!fs.existsSync(image)) {
          const partialImage = image.replace(/\.jpg$/, '.part.jpg');
          try {
            await runSimple(o.ffmpeg, ['-ss', String(first!.src[0]), '-i', c.videoFile, '-frames:v', '1', '-q:v', '2', partialImage], workDir, o.signal);
            fs.renameSync(partialImage, image);
          } finally { fs.rmSync(partialImage, { force: true }); }
        }
        blurred = true;
      }
      jobs.push({ job: buildIntroJob({ image, blurred, seconds: tl.introEnd, size, fps, preview: req.preview, workDir, layout: project.intro.layout }), label: 'intro card' });
    }
    clips.forEach((c, i) => {
      const segs = tl.segments.filter((s) => s.clipIndex === i && s.kind !== 'intro');
      if (segs.length) jobs.push({ job: buildClipJob({ clip: c, overlays: project.overlays, audioCount: audioCounts.get(c.videoFile), segments: segs, size, fps, style: project.style, preview: req.preview, workDir }), label: `clip ${i + 1} of ${clips.length}` });
    });

    const clipShare = 0.6;
    for (let j = 0; j < jobs.length; j++) {
      const { job, label } = jobs[j];
      inputs.push(job.output);
      if (fs.existsSync(job.output) && fs.statSync(job.output).size > 0) continue;
      const tmp = job.output.replace(/\.mkv$/, '.part.mkv');
      job.args[job.args.length - 1] = tmp;
      await runFfmpeg(o.ffmpeg, job, workDir, (p) => report('clips', (clipShare * (j + p)) / jobs.length, `Cutting ${label}`), o.signal);
      fs.renameSync(tmp, job.output);
    }

    const out = req.preview ? path.join(workDir, `preview-${Date.now()}.mp4`) : path.join(o.reelsDir, `${base}_${f.id}.mp4`);
    const noMusicAudio = !req.preview && req.noMusicCopy && project.music ? path.join(workDir, `nomusic-${Date.now()}.m4a`) : undefined;
    const anyMic = clips.some((c) => c.useMic && c.hasMic);
    const job = buildAssembleJob({
      inputs,
      timeline: tl,
      style: project.style,
      mix: project.mix,
      format: f,
      size,
      fps,
      music: project.music ? { file: project.music.file, start: tl.musicStart } : null,
      anyMic,
      preview: req.preview,
      encoder: req.preview ? { name: 'libx264' } : o.encoder,
      output: out,
      noMusicAudio,
      workDir,
      fontFile: font,
      intro: project.intro,
      outro: project.outro,
    });
    const partialOut = out.replace(/\.mp4$/, '.part.mp4');
    job.args = job.args.map(arg => arg === out ? partialOut : arg);
    try {
      await runFfmpeg(o.ffmpeg, job, workDir, (p) => report('assemble', clipShare + (1 - clipShare) * p, req.preview ? 'Rendering preview' : `Rendering ${fmts.map((x) => x.label).join(' + ')}`), o.signal);
      fs.renameSync(partialOut, out);
    } catch (error) {
      if (noMusicAudio) fs.rmSync(noMusicAudio, { force: true });
      throw error;
    } finally { fs.rmSync(partialOut, { force: true }); }
    files.push(out);
    for (const extra of fmts.slice(1)) {
      const copy = path.join(o.reelsDir, `${base}_${extra.id}.mp4`);
      fs.copyFileSync(out, copy);
      files.push(copy);
    }
    if (noMusicAudio) {
      for (const fm of fmts) {
        const src = fm === f ? out : path.join(o.reelsDir, `${base}_${fm.id}.mp4`);
        const dst = src.replace(/\.mp4$/, '_nomusic.mp4');
        const partialCopy = dst.replace(/\.mp4$/, '.part.mp4');
        try {
          await runSimple(o.ffmpeg, ['-i', src, '-i', noMusicAudio, '-map', '0:v', '-map', '1:a', '-c', 'copy', '-movflags', '+faststart', partialCopy], workDir, o.signal);
          fs.renameSync(partialCopy, dst);
        } finally { fs.rmSync(partialCopy, { force: true }); }
        files.push(dst);
      }
      fs.rmSync(noMusicAudio, { force: true });
    }
    gi++;
  }
  if (!req.preview) pruneCache(workDir);
  else prunePreviews(workDir);
  return files;
}

/** Full-quality intermediates are big; keep the cache for previews only. */
function pruneCache(workDir: string) {
  for (const f of fs.readdirSync(workDir)) {
    const p = path.join(workDir, f);
    try {
      if (/^(clip|intro)-.*\.mkv$/.test(f) && fs.statSync(p).size > 40e6) fs.rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function prunePreviews(workDir: string) {
  const previews = fs
    .readdirSync(workDir)
    .filter((f) => /^preview-\d+\.mp4$/.test(f))
    .sort();
  for (const f of previews.slice(0, -2)) fs.rmSync(path.join(workDir, f), { force: true });
}
