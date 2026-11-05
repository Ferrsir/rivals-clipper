import { externalClip, footageName, reelClipFromSidecar, sanitizeProject } from './projects';
// Studio features that use your own Claude or ChatGPT sign-in (through the shell's AiClient).
// Everything sent is text: clip facts from the sidecars, style settings, your request. No video.
// Every reply is validated, so a bad answer can't break a project.

import type { AiClient } from '../ai-auth';
import type { AiMusicIdea, ExportFormat, ReelClip, ReelProject, StyleRecipe } from '../../shared/studio';
import type { ClipSidecar } from '../../shared/types';
import { sanitizeStyle } from './styles';

const SYSTEM = 'You help edit short gameplay and fan-edit videos (Marvel Rivals or any other game, anime, show or film). Be concise. Follow the requested JSON shape exactly.';

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
    .map((c, i) => c.external ? `${i + 1}. their own footage (${c.hits.length} action moments, ${(c.out - c.in).toFixed(1)} s)` : `${i + 1}. ${c.hero ?? 'unknown hero'}, ${c.kills} kill${c.kills === 1 ? '' : 's'}${c.tags.length ? ` (${c.tags.slice(0, 6).join(', ')})` : ''}${c.map ? ` on ${c.map}` : ''}`)
    .join('\n');
}

/** Story or lyric-style caption lines, like the reference edits. */
export async function writeCaptions(ai: AiClient | undefined, p: ReelProject, request: string, lines: number): Promise<string[]> {
  const prompt = [
    `Write ${lines} short on-screen caption lines for a ${p.style.name} ${footageName(p)} edit. They appear one after another, each for a few beats, telling a tiny story or joke that builds to the best play. Each line at most 6 words. No hashtags, no emojis.`,
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
    `Write the post caption for this ${format.label} upload: one punchy line, then 5 to 8 relevant hashtags${footageName(p) === 'Marvel Rivals' ? ' (include #marvelrivals)' : ` for ${footageName(p)}`}.`,
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


export async function reviseReel(ai: AiClient | undefined, project: ReelProject, request: string, library: ClipSidecar[] = []): Promise<{project: ReelProject; summary: string}> {
  if (!request.trim() || request.length > 20000) throw new Error('Describe the changes in up to 20,000 characters.');
  const inProject = new Set(project.clips.map(c => c.videoFile));
  const candidates = library
    .filter(c => !inProject.has(c.videoFile) && c.events.some(e => e.type === 'kill'))
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.score - a.score)
    .slice(0, 60)
    .map(c => ({ clipId: c.id, hero: c.hero, kills: c.events.filter(e => e.type === 'kill').length, tags: c.tags.filter(t => !t.includes(':')).slice(0, 5), score: c.score, seconds: Math.round(c.durationMs / 100) / 10 }));
  const assets = (project.assets ?? []).map(a => ({ id: `asset:${a.id}`, kind: a.kind, name: a.name, seconds: a.durationSec }));
  const current = { ...project, clips: project.clips.map(c => ({ uid: c.uid, clipId: c.clipId, hero: c.hero, kills: c.kills, hits: c.hits, in: c.in, out: c.out, durationSec: c.durationSec, external: c.external, cropX: c.cropX, cropY: c.cropY, cropZoom: c.cropZoom, preserveKillFeed: c.preserveKillFeed })) };
  const reply = await askJson(ai, [
    `Revise this existing ${footageName(project)} edit so it does what the creator asks.`,
    'Your own footage (external) can be from any game, anime or film; its hits are detected action moments, not kills, and its in/out can be trimmed freely (add the same asset again to use another excerpt).',
    ' Really make the change: if they ask for a longer reel or more clips, ADD clips from the library list; if shorter, remove the weakest. Keep its imported music. Preserve all marked kills (hits) in every retained clip; remove a whole clip instead if it cannot fit.',
    'Every clip should end right after its last kill and cut to the next one on the beat. Keep the character centred (cropX 0.5) unless asked otherwise. Keep the kill feed box (preserveKillFeed true) on game clips.',
    'Return JSON {clips:[{uid,in,out,cropX,cropY,cropZoom,preserveKillFeed} for kept clips | {clipId} to add a library clip | {clipId:"asset:..."} to add one of their videos], targetSeconds:number, musicStart:number|"auto", style:<complete style>, mix:<complete mix>, overlays:[{assetId,onClip (a uid, library clipId or asset id),from,to (seconds inside that clip),anchor:"face"|"fixed",x,y,size,shape:"circle"|"square"}], subtitles:[{onClip,from,to,text}], summary:string}. List every clip in the order it should play. Keep unchanged values.',
    'Do not add captions, intro cards, subtitles or text unless the request asks for them. Subtitles use only words the creator gave you.',
    `Current edit: ${JSON.stringify(current)}`,
    `Library clips you can add: ${JSON.stringify(candidates)}`,
    assets.length ? `Their own media: ${JSON.stringify(assets)}` : '',
    `Request: ${request}`,
  ].filter(Boolean).join('\n\n'), 180000);
  if (!reply || typeof reply !== 'object') throw new Error('No usable revision was returned.');
  const byId = new Map(project.clips.map(clip => [clip.uid,clip]));
  const libById = new Map(library.map(c => [c.id, c]));
  const assetById = new Map((project.assets ?? []).map(a => [a.id, a]));
  const patches = Array.isArray(reply.clips) ? reply.clips : project.clips;
  const seen = new Set<string>();
  const uidFor = new Map<string, string>(project.clips.map(c => [c.uid, c.uid]));
  for (const c of project.clips) uidFor.set(c.clipId, c.uid);
  const clips: ReelClip[] = [];
  for (const patch of patches) {
    if (patch && typeof patch.clipId === 'string' && !byId.has(patch.uid)) {
      // Another excerpt of one of your own videos, already in the edit.
      if (patch.clipId.startsWith('asset:') && (seen.has(patch.clipId) || project.clips.some(c => c.clipId === patch.clipId))) {
        const a = assetById.get(patch.clipId.slice(6));
        if (a?.kind === 'video' && Number.isFinite(patch.in) && Number.isFinite(patch.out) && patch.out > patch.in + 0.2) {
          const more = externalClip(a);
          more.in = Math.max(0, patch.in);
          more.out = Math.min(more.durationSec, patch.out);
          more.hits = more.hits.filter((h) => h > more.in + 0.05 && h < more.out - 0.02);
          if (more.out > more.in + 0.2) clips.push(more);
        }
        continue;
      }
      // A clip being added.
      let added: ReelClip | undefined;
      if (patch.clipId.startsWith('asset:')) {
        const a = assetById.get(patch.clipId.slice(6));
        if (a?.kind === 'video') added = externalClip(a);
      } else {
        const src = libById.get(patch.clipId);
        if (src && !project.clips.some(c => c.videoFile === src.videoFile)) added = reelClipFromSidecar(src);
      }
      if (!added || seen.has(patch.clipId)) continue;
      if (added.external && Number.isFinite(patch.in) && Number.isFinite(patch.out) && patch.out > patch.in + 0.2) {
        added.in = Math.max(0, patch.in);
        added.out = Math.min(added.durationSec, patch.out);
        added.hits = added.hits.filter((h) => h > added!.in + 0.05 && h < added!.out - 0.02);
      }
      seen.add(patch.clipId);
      uidFor.set(patch.clipId, added.uid);
      clips.push(added);
      continue;
    }
    const original = byId.get(patch?.uid);
    if (!original || seen.has(original.uid)) continue;
    seen.add(original.uid);
    const revised = {...original, ...Object.fromEntries(['in','out','cropX','cropY','cropZoom','preserveKillFeed'].filter(key=>patch[key]!==undefined).map(key=>[key,patch[key]]))};
    if (!Number.isFinite(revised.in) || !Number.isFinite(revised.out) || revised.in < 0 || revised.out > original.durationSec || revised.in >= revised.out) throw new Error('The revision contains an invalid source trim.');
    // Detected action moments in your own footage are suggestions, so only kill markers are protected.
    if (original.external) { revised.hits = original.hits.filter(h => h > revised.in + 0.05 && h < revised.out - 0.02); clips.push(revised); continue; }
    const retainedHits = original.hits.filter(hit => hit > original.in + 0.05 && hit < original.out - 0.02);
    if (retainedHits.some(hit => hit <= revised.in + 0.05 || hit >= revised.out - 0.02)) throw new Error('The revision would cut a marked kill out of a retained streak. Revise the duration or remove the whole clip.');
    clips.push(revised);
  }
  if (!clips.length) throw new Error('The revision removed every clip.');
  const musicStart = reply.musicStart;
  if (musicStart !== undefined && musicStart !== 'auto' && (!Number.isFinite(musicStart) || musicStart < 0)) throw new Error('The revision contains an invalid music start.');
  const wantsText = /\b(subtitle|caption|text|words|intro|hook|title)/i.test(request);
  const overlays = Array.isArray(reply.overlays) ? reply.overlays.map((o: any) => {
    const image = assetById.get(String(o?.assetId ?? '').replace(/^asset:/, ''));
    const clipUid = uidFor.get(o?.onClip);
    return image?.kind === 'image' && clipUid ? { ...o, image: image.file, clipUid, anchor: o.anchor === 'fixed' ? 'fixed' : 'face' } : null;
  }).filter(Boolean) : project.overlays;
  const subtitles = wantsText && Array.isArray(reply.subtitles) ? reply.subtitles.map((t: any) => ({ ...t, clipUid: uidFor.get(t?.onClip) })) : project.subtitles;
  return {project:sanitizeProject({...project,clips,order:Array.isArray(reply.clips)?'manual':project.order,targetSeconds:reply.targetSeconds ?? project.targetSeconds,music:project.music && musicStart !== undefined ? {...project.music,start:musicStart}:project.music,style:reply.style || project.style,mix:reply.mix || project.mix,intro:wantsText?project.intro:null,outro:wantsText?project.outro:null,captions:wantsText?project.captions:[],overlays,subtitles}),summary:typeof reply.summary==='string'?reply.summary.slice(0,500):'Updated the edit.'};
}
