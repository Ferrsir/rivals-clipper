import { sanitizeProject } from './projects';
// Studio features that use your own Claude or ChatGPT sign-in (through the shell's AiClient).
// Everything sent is text: clip facts from the sidecars, style settings, your request. No video.
// Every reply is validated, so a bad answer can't break a project.

import type { AiClient } from '../ai-auth';
import type { AiMusicIdea, ExportFormat, ReelProject, StyleRecipe } from '../../shared/studio';
import type { ClipSidecar } from '../../shared/types';
import { sanitizeStyle } from './styles';

const SYSTEM = 'You help edit short Marvel Rivals gameplay videos. Be concise. Follow the requested JSON shape exactly.';

function need(ai: AiClient | undefined): AiClient {
  if (!ai) throw new Error('Sign in to Claude or ChatGPT first (Settings, Account).');
  return ai;
}

async function askJson(ai: AiClient | undefined, prompt: string, timeoutMs = 120_000): Promise<any> {
  const r = await need(ai).ask({ prompt, system: SYSTEM, expectJson: true, timeoutMs });
  if (r.json === undefined) throw new Error('The AI reply had no JSON in it. Try again.');
  return r.json;
}

/** "More shake, slower intro" -> an updated style, clamped to safe values. */
export async function tweakStyle(ai: AiClient | undefined, style: StyleRecipe, request: string): Promise<{ style: StyleRecipe; summary: string }> {
  const prompt = [
    'Here is a video edit style as JSON. Field meanings: speeds are playback multipliers; leadIn/tail are seconds before the first kill / after the last; slowmo.before/after are source seconds slowed around each kill; zoom.amount is a scale (1.15 = 15% punch); shake.amount is a fraction of frame width; flash.strength 0..1; grade values are multipliers (1 = unchanged); echo is afterimage trails; transition is one of cut, flash, dip, whip; captions.size is text height as a fraction of frame width.',
    JSON.stringify(style),
    `Change it to match this request: "${request.slice(0, 500)}"`,
    'Only change what the request asks for. Reply as JSON: {"style": <the full updated style>, "summary": "one sentence describing what you changed"}',
  ].join('\n\n');
  const j = await askJson(ai, prompt);
  const next = sanitizeStyle(j?.style ?? j, style);
  next.id = style.id;
  return { style: next, summary: typeof j?.summary === 'string' ? j.summary.slice(0, 300) : 'Style updated.' };
}

function clipFacts(p: ReelProject): string {
  return p.clips
    .map((c, i) => `${i + 1}. ${c.hero ?? 'unknown hero'}, ${c.kills} kill${c.kills === 1 ? '' : 's'}${c.tags.length ? ` (${c.tags.slice(0, 6).join(', ')})` : ''}${c.map ? ` on ${c.map}` : ''}`)
    .join('\n');
}

/** Story or lyric-style caption lines, like the reference edits. */
export async function writeCaptions(ai: AiClient | undefined, p: ReelProject, request: string, lines: number): Promise<string[]> {
  const prompt = [
    `Write ${lines} short on-screen caption lines for a ${p.style.name} Marvel Rivals edit. They appear one after another, each for a few beats, telling a tiny story or joke that builds to the best play. Each line at most 6 words. No hashtags, no emojis.`,
    `Clips in order:\n${clipFacts(p) || '(no clips yet)'}`,
    p.music ? `Song: ${p.music.title}.` : '',
    request ? `The creator's idea: "${request.slice(0, 400)}"` : '',
    'Reply as JSON: {"lines": ["...", "..."]}',
  ]
    .filter(Boolean)
    .join('\n\n');
  const j = await askJson(ai, prompt);
  const arr: unknown[] = Array.isArray(j) ? j : Array.isArray(j?.lines) ? j.lines : [];
  const out = arr
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.replace(/\s+/g, ' ').trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, 30);
  if (!out.length) throw new Error('The AI did not write any caption lines. Try again.');
  return out;
}

export async function postCaption(ai: AiClient | undefined, p: ReelProject, format: ExportFormat): Promise<string> {
  const prompt = [
    `Write the post caption for this ${format.label} upload: one punchy line, then 5 to 8 relevant hashtags (include #marvelrivals).`,
    `Clips:\n${clipFacts(p)}`,
    'Reply as JSON: {"caption": "..."}',
  ].join('\n\n');
  const j = await askJson(ai, prompt, 60_000);
  const c = typeof j?.caption === 'string' ? j.caption : typeof j === 'string' ? j : '';
  if (!c) throw new Error('The AI did not return a caption.');
  return c.slice(0, 2200);
}

export async function musicIdeas(ai: AiClient | undefined, prompt: string): Promise<AiMusicIdea[]> {
  const j = await askJson(ai, prompt);
  const arr: any[] = Array.isArray(j) ? j : Array.isArray(j?.ideas) ? j.ideas : [];
  return arr
    .filter((x) => x && typeof x.title === 'string')
    .slice(0, 12)
    .map((x) => ({
      title: String(x.title).slice(0, 120),
      artist: typeof x.artist === 'string' ? x.artist.slice(0, 120) : undefined,
      genre: typeof x.genre === 'string' ? x.genre.slice(0, 60) : undefined,
      why: String(x.why ?? '').slice(0, 240),
      where: String(x.where ?? '').slice(0, 160),
      search: String(x.search ?? `${x.title} ${x.artist ?? ''}`).slice(0, 160),
    }));
}

/** Let the AI choose and order clips for a target length, from the library's facts. */
export async function pickClips(ai: AiClient | undefined, clips: ClipSidecar[], format: ExportFormat, styleName: string, seconds: number): Promise<string[]> {
  const list = clips.slice(0, 80).map((c) => ({
    id: c.id,
    hero: c.hero,
    kills: c.events.filter((e) => e.type === 'kill').length,
    tags: c.tags.filter((t) => !t.includes(':')).slice(0, 8),
    score: c.score,
    rating: c.rating,
    map: c.match?.map,
  }));
  const prompt = [
    `Pick clips for a ${Math.round(seconds)}-second ${format.label} edit in a "${styleName}" style. A clip uses about 3 to 5 seconds. Order them so it builds: good plays first, the best play last. Prefer variety of heroes and maps, avoid near-duplicates.`,
    JSON.stringify(list),
    'Reply as JSON: {"ids": ["clip id", ...], "why": "one sentence"}',
  ].join('\n\n');
  const j = await askJson(ai, prompt);
  const ids: unknown[] = Array.isArray(j?.ids) ? j.ids : Array.isArray(j) ? j : [];
  const known = new Set(clips.map((c) => c.id));
  return ids.filter((x): x is string => typeof x === 'string' && known.has(x)).slice(0, 30);
}


export async function reviseReel(ai: AiClient | undefined, project: ReelProject, request: string): Promise<{project: ReelProject; summary: string}> {
  if (!request.trim() || request.length > 20000) throw new Error('Describe the changes in up to 20,000 characters.');
  const reply = await askJson(ai, [
    'Revise this existing gameplay edit. Keep its imported music source. Only use clips already in the project. Preserve all marked kills in every retained clip; remove a whole clip instead if the duration budget cannot accommodate its complete streak.',
    'Return JSON {clips:[{uid,in,out,cropX,cropY,cropZoom,preserveKillFeed,followCharacter}],targetSeconds:number,musicStart:number|"auto",style:<complete style>,mix:<complete mix>,summary:string}. Keep unchanged values. You may change the imported song start and duration budget when requested. Do not add captions, intro cards or text. Include every retained clip, in desired order. Kill feed must remain visible in vertical outputs.',
    JSON.stringify(project), request,
  ].join('\n\n'), 180000);
  if (!reply || typeof reply !== 'object') throw new Error('No usable revision was returned.');
  const byId = new Map(project.clips.map(clip => [clip.uid,clip]));
  const patches = Array.isArray(reply.clips) ? reply.clips : project.clips;
  const seen = new Set<string>();
  const clips = patches.map((patch: any) => {
    const original = byId.get(patch?.uid);
    if (!original || seen.has(original.uid)) throw new Error('The revision selected an unavailable or duplicate clip.');
    seen.add(original.uid);
    const revised = {...original, ...Object.fromEntries(['in','out','cropX','cropY','cropZoom','preserveKillFeed','followCharacter'].filter(key=>patch[key]!==undefined).map(key=>[key,patch[key]]))};
    if (!Number.isFinite(revised.in) || !Number.isFinite(revised.out) || revised.in < 0 || revised.out > original.durationSec || revised.in >= revised.out) throw new Error('The revision contains an invalid source trim.');
    const retainedHits = original.hits.filter(hit => hit > original.in + 0.05 && hit < original.out - 0.02);
    if (retainedHits.some(hit => hit <= revised.in + 0.05 || hit >= revised.out - 0.02)) throw new Error('The revision would cut a marked kill out of a retained streak. Revise the duration or remove the whole clip.');
    return revised;
  });
  if (!clips.length) throw new Error('The revision removed every clip.');
  const musicStart = reply.musicStart;
  if (musicStart !== undefined && musicStart !== 'auto' && (!Number.isFinite(musicStart) || musicStart < 0)) throw new Error('The revision contains an invalid music start.');
  return {project:sanitizeProject({...project,clips,order:Array.isArray(reply.clips)?'manual':project.order,targetSeconds:reply.targetSeconds ?? project.targetSeconds,music:project.music && musicStart !== undefined ? {...project.music,start:musicStart}:project.music,style:reply.style || project.style,mix:reply.mix || project.mix,intro:null,outro:null,captions:[]}),summary:typeof reply.summary==='string'?reply.summary.slice(0,500):'Updated the edit.'};
}
