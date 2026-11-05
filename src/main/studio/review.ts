import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AiClient } from '../ai-auth';
import type { MusicAnalysis, ReelProject } from '../../shared/studio';
import { planFor } from './pipeline';

export interface ReelReview {
  verdict: 'needs-changes' | 'ready-for-user-review';
  provider: string;
  summary: string;
  issues: string[];
  limits: string[];
  frames: number;
  references: number;
  file: string;
  at: number;
}

function run(ffmpeg: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(ffmpeg, ['-hide_banner', '-nostdin', ...args],
    { windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(new Error(String(stderr).slice(-1000) || error.message)) : resolve(String(stdout) + String(stderr))));
}

export function reviewTimes(duration:number,kills:number[]):number[] {
  const end=Math.max(0,duration-.06);
  const times=[...kills.map(time=>Math.min(end,Math.max(0,time+.15))),0,end];
  for(let i=0;i<8;i++) times.push(Math.min(end,duration*(i+.5)/8));
  const selected:number[]=[];
  for(const time of times) if(!selected.some(value=>Math.abs(value-time)<.08) && selected.length<12) selected.push(time);
  return selected.sort((a,b)=>a-b);
}

/** Review the rendered file, not the AI's proposed edit. Frame review cannot certify motion or sound. */
export async function reviewRenderedReel(o: {
  ai?: AiClient; ffmpeg: string; file: string; project: ReelProject;
  analysis: MusicAnalysis | null; request: string; reviewDir: string; referenceImages?: string[];
}): Promise<ReelReview> {
  if (!o.ai) throw new Error('Choose a signed-in AI provider in Settings first.');
  if (!fs.existsSync(o.file)) throw new Error('Render a preview before reviewing it.');
  const timeline = planFor(o.project, o.analysis, 30);
  fs.mkdirSync(o.reviewDir, { recursive: true });
  const directory = fs.mkdtempSync(path.join(o.reviewDir, 'pass-'));
  const audio = await run(o.ffmpeg, ['-i', o.file, '-t', '300', '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  const durationMatch = audio.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  if (!durationMatch) throw new Error('Could not measure the rendered duration.');
  const duration = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
  const times=reviewTimes(Math.min(duration,300),timeline.kills);
  for(const [index,time] of times.entries()) await run(o.ffmpeg,['-y','-ss',String(time),'-i',o.file,'-vf','scale=540:-2','-frames:v','1',path.join(directory,`frame-${String(index).padStart(2,'0')}.jpg`)]);
  const frames = fs.readdirSync(directory).filter(name => /^frame-\d+\.jpg$/.test(name)).sort().map(name => path.join(directory, name));
  if (!frames.length) throw new Error('The rendered reel has no readable frames.');
  const references=(o.referenceImages ?? []).filter(file=>fs.existsSync(file) && /\.(png|jpe?g)$/i.test(file)).slice(0,2);
  const mean = audio.match(/mean_volume:\s*(-?[\d.]+|-inf) dB/);
  const measuredDb = mean ? Number(mean[1]) : undefined;
  const issues = [...timeline.warnings];
  if (o.project.music && (!mean || !Number.isFinite(measuredDb) || measuredDb! < -50)) issues.push('Rendered audio is silent or extremely quiet despite selected music.');
  if (Math.abs(duration - timeline.duration) > .25) issues.push(`Rendered duration ${duration.toFixed(2)}s differs from the planned ${timeline.duration.toFixed(2)}s.`);
  const limits = ['Sampled frames cannot certify every frame, kill detection, character tracking throughout, or audible beat synchronization. Human playback review is required.'];
  const result = await o.ai.ask({
    system: 'You are a demanding gameplay edit reviewer. Inspect the supplied rendered frames. Never treat the proposed plan as proof of visual quality. Never claim you heard audio from images. Do not invent a reference comparison.',
    prompt: [
      'Review this Marvel Rivals reel: player should stay lower-central, gameplay fills the canvas, small readable kill banners upper right over the original clock area, no irrelevant HUD clutter or text cards, distinct plays and complete streaks.',
      'These are chronological sampled frames, not the complete video. Critique clipping of the player, scenery pasted as a feed, unreadable feed names, objective timer clutter and unwanted captions. Be strict. If uncertain list the limitation.',
      `Output frame times in seconds: ${JSON.stringify(times)}. Samples prioritize just after marked kills so the last elimination is not omitted by uniform sampling.`,
      references.length ? `The first ${frames.length} images are output frames. The final ${references.length} images are actual style references. Compare framing and feed treatment directly; the reference may be square while this output is vertical. Do not claim identical motion or audio from stills.` : 'No reference images are supplied. Do not claim a comparison to earlier videos.',
      `The project duration budget is ${o.project.targetSeconds ?? 'unspecified'} seconds MAXIMUM, not an exact duration. Shorter is acceptable unless the user explicitly specifies a minimum. In-game subtitles are baked into source footage; distinguish them from captions added by Studio.`,
      `User request: ${o.request.slice(0, 20000)}`,
      `Measured duration ${duration}s. Audio mean ${measuredDb ?? 'unknown'} dB. Planned kill times ${JSON.stringify(timeline.kills)}. Beat warnings ${JSON.stringify(timeline.warnings)}.`,
      'Return JSON {summary:string,issues:string[],limits:string[]}. Do not give a quality score or claim approval by other reviewers.',
    ].join('\n\n'), imagePaths: [...frames,...references], expectJson: true, timeoutMs: 180000,
  });
  const value = result.json as { summary?: unknown; issues?: unknown; limits?: unknown } | undefined;
  if (!value || typeof value.summary !== 'string' || !Array.isArray(value.issues)) throw new Error('The reviewer returned an unusable response.');
  const strings = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 20).map(x => x.slice(0, 1000)) : [];
  issues.push(...strings(value.issues)); limits.push(...strings(value.limits));
  const review: ReelReview = { verdict: issues.length ? 'needs-changes' : 'ready-for-user-review', provider: result.provider,
    summary: value.summary.slice(0, 2000), issues, limits, frames: frames.length, references:references.length, file: o.file, at: Date.now() };
  fs.writeFileSync(path.join(directory, 'review.json'), JSON.stringify(review, null, 2));
  return review;
}
