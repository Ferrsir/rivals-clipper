// Reel ideas: concepts in the spirit of the reference edits (a hook card, a little story told in
// captions, the best play on the drop), built from what's actually in the clip library.
// Quick ideas come from the clips' tags and need no AI; AI ideas ask Claude/ChatGPT for more creative ones.

import crypto from 'node:crypto';
import type { AiClient } from '../ai-auth';
import type { ClipSidecar } from '../../shared/types';
import type { ExportFormat, FormatId, MusicTrack, ReelIdea } from '../../shared/studio';
import { STYLES } from './styles';
import { hookText } from './projects';

/** What the reference edits do, in words the AI can work from. */
export const REFERENCE_STYLE = [
  'Reference edits (TikTok creator @imfuzedb, Marvel Rivals): 25 to 55 seconds.',
  'They open on a hook card for 3 to 8 seconds: a hero picture or meme in a strip across the middle of the screen over a blurred copy of it, with big bold capital text under it.',
  'The hook is often a short back-and-forth, one line at a time ("WHO\'S STRONGER?" / "HIM?" / "OR YOU?", or "I CAN\'T BELIEVE IT" / "SUCH AN UNKILLABLE DUO!" / "MAYBE NOT..."), or a single "POV: YOU MAIN DEADPOOL".',
  'Then gameplay cut on the beat in 3 to 7 second pieces, punched in on the hero, with white flashes on cuts, afterimage trails on the big moment and the best kill landing on the song\'s drop. Short story captions can run over it.',
  'It ends with big text over the last seconds ("JOIN US DP MAINS!", "Please buff us", "Tysm for 2k") and a fade to black. The tone is funny, confident and a little self-aware.',
].join(' ');

const SECONDS_PER_CLIP = 4.5;

const kills = (c: ClipSidecar) => c.events.filter((e) => e.type === 'kill').length;
const plainTags = (c: ClipSidecar) => c.tags.filter((t) => !t.includes(':'));
const id = () => crypto.randomBytes(5).toString('hex');

function pickTrack(tracks: MusicTrack[], bpm: [number, number], minEnergy = 0): string | undefined {
  const ok = tracks.filter((t) => t.analysis && t.license !== 'unknown' && t.analysis.bpm >= bpm[0] - 4 && t.analysis.bpm <= bpm[1] + 4 && t.analysis.energy >= minEnergy);
  ok.sort((a, b) => (b.analysis!.drops.length ? 1 : 0) - (a.analysis!.drops.length ? 1 : 0) || b.analysis!.energy - a.analysis!.energy);
  return ok[0]?.id;
}

function byScore(list: ClipSidecar[]): ClipSidecar[] {
  return [...list].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.score - a.score);
}

/** Weakest first, so the best play closes the reel and lands on the drop. */
function buildUp(list: ClipSidecar[]): string[] {
  return [...list].sort((a, b) => a.score - b.score).map((c) => c.id);
}

/** A handful of ideas straight from the library's tags. Always available, no sign-in needed. */
export function quickIdeas(clips: ClipSidecar[], tracks: MusicTrack[], format: ExportFormat, count = 6): ReelIdea[] {
  const usable = clips.filter((c) => kills(c) > 0);
  if (!usable.length) return [];
  const n = Math.max(3, Math.round(format.idealSeconds[1] / SECONDS_PER_CLIP));
  const ideas: ReelIdea[] = [];
  const base = (o: Partial<ReelIdea> & Pick<ReelIdea, 'title' | 'concept' | 'hook' | 'clipIds' | 'styleId'>): ReelIdea => ({
    id: id(),
    imageIdea: '',
    imageSearch: '',
    captions: [],
    format: format.id as FormatId,
    music: { mood: 'hard-hitting', search: 'phonk', bpm: [120, 150] },
    why: '',
    source: 'quick',
    ...o,
  });

  // Most-played hero spotlight.
  const heroes = new Map<string, ClipSidecar[]>();
  for (const c of usable) if (c.hero) heroes.set(c.hero, [...(heroes.get(c.hero) ?? []), c]);
  const topHero = [...heroes.entries()].sort((a, b) => b[1].length - a[1].length || byScore(b[1])[0].score - byScore(a[1])[0].score)[0];
  if (topHero && topHero[1].length >= 2) {
    const [hero, list] = topHero;
    ideas.push(
      base({
        title: `${hero} spotlight`,
        concept: `Your best ${hero} plays, building to the cleanest one on the drop.`,
        hook: `POV: you main ${hero}`,
        endText: `${hero} mains, where you at?`,
        imageIdea: `${hero} looking smug or a reaction meme`,
        imageSearch: `${hero} marvel`,
        captions: [`They said ${hero} was a throw pick`, 'So I queued anyway', 'Then this happened', 'Still a throw pick?'],
        clipIds: buildUp(byScore(list).slice(0, n)),
        styleId: 'story',
        music: { mood: 'confident, bass-heavy', bpm: [125, 150], search: 'phonk bass', trackId: pickTrack(tracks, [125, 150]) },
        why: `${list.length} ${hero} clips: a single-hero edit reads as a story and gets "main" comments.`,
      }),
    );
  }

  // Team wipes and multi-kills, fast cuts.
  const big = byScore(usable.filter((c) => c.tags.some((t) => ['team-wipe', 'triple', 'quad', 'penta', 'hexa'].includes(t)) || kills(c) >= 3));
  if (big.length >= 2) {
    ideas.push(
      base({
        title: 'Team wipe montage',
        concept: 'Only the multi-kills and team wipes, cut hard on every beat.',
        hook: 'POV: the enemy team queued into me',
        endText: 'Rate it 1-10',
        imageIdea: 'shocked or crying reaction face',
        imageSearch: 'shocked face reaction',
        captions: ['Warm up', 'Getting started', 'Okay now it counts', 'Team wipe'],
        clipIds: buildUp(big.slice(0, n)),
        styleId: 'velocity',
        music: { mood: 'aggressive, fast', bpm: [135, 170], search: 'aggressive electronic', trackId: pickTrack(tracks, [135, 170], 0.5) },
        why: `${big.length} clips with 3 or more kills. Fast edits with constant payoff keep people watching to the end.`,
      }),
    );
  }

  // Who's stronger: your two most-played heroes against each other, like the reference duel edits.
  const pair = [...heroes.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 2);
  if (pair.length === 2) {
    const [[a, la], [b, lb]] = pair;
    const half = Math.max(2, Math.floor(n / 2));
    ideas.push(
      base({
        title: `${a} or ${b}?`,
        concept: `Your best ${a} plays against your best ${b} plays. Let the comments decide.`,
        hook: `Who's stronger?\n${a}?\nOr ${b}?`,
        endText: 'Comment who wins',
        imageIdea: `${a} and ${b} side by side`,
        imageSearch: 'versus battle',
        captions: [`${a} first`, 'Not bad', `Now ${b}`, 'Okay...'],
        clipIds: [...buildUp(byScore(la).slice(0, half)), ...buildUp(byScore(lb).slice(0, half))],
        styleId: 'story',
        music: { mood: 'hype, big drop', bpm: [125, 150], search: 'hype electronic drop', trackId: pickTrack(tracks, [125, 150]) },
        why: 'A "who wins" question gets people arguing in the comments, which pushes the video.',
      }),
    );
  }

  // Ult moments.
  const ults = byScore(usable.filter((c) => c.tags.includes('ult')));
  if (ults.length >= 2) {
    ideas.push(
      base({
        title: 'Ult value',
        concept: 'Every ult that turned a fight, each one punched in with slow-mo on the kill.',
        hook: 'Is this ult broken?\nAsking for a friend',
        endText: 'Please don\'t nerf it',
        imageIdea: 'galaxy-brain or "stonks" meme',
        imageSearch: 'galaxy brain meme',
        captions: ['Ult ready', 'Wait for it', 'Value', 'More value', 'Okay that is enough value'],
        clipIds: buildUp(ults.slice(0, n)),
        styleId: 'beat-cuts',
        music: { mood: 'epic build to a drop', bpm: [120, 140], search: 'epic trailer drop', trackId: pickTrack(tracks, [120, 140]) },
        why: `${ults.length} ult clips. Repeated setup-and-payoff makes a clear format people recognise.`,
      }),
    );
  }

  // Clutch.
  const clutch = byScore(usable.filter((c) => c.tags.includes('clutch') || c.tags.includes('match-winner')));
  if (clutch.length >= 1) {
    ideas.push(
      base({
        title: 'Last one standing',
        concept: 'Clutch fights where you were the last one alive, told as a comeback.',
        hook: 'My team left me 1v5\nBig mistake',
        endText: 'Follow for part 2',
        imageIdea: 'lonely or "this is fine" meme',
        imageSearch: 'this is fine dog',
        captions: ['Team is dead', 'Five of them', 'One of me', 'Not today'],
        clipIds: buildUp(clutch.slice(0, Math.max(2, Math.min(n, clutch.length)))),
        styleId: 'story',
        music: { mood: 'tense build, big drop', bpm: [110, 140], search: 'cinematic tension drop', trackId: pickTrack(tracks, [110, 140]) },
        why: 'Clutches have built-in tension, so viewers stay to see if you pull it off.',
      }),
    );
  }

  // One perfect clip.
  const best = byScore(usable)[0];
  ideas.push(
    base({
      title: 'Wait for it',
      concept: 'Your single best clip, slowed down on every kill, nothing else.',
      hook: 'Wait for it...',
      endText: 'Clean or lucky?',
      imageIdea: '',
      imageSearch: '',
      captions: [],
      clipIds: [best.id],
      styleId: 'cinematic',
      music: { mood: 'slow, cinematic', bpm: [80, 110], search: 'cinematic slow dramatic', trackId: pickTrack(tracks, [80, 110]) },
      why: 'Short single-clip edits get rewatched, which the algorithm rewards.',
    }),
  );

  return ideas.slice(0, count);
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** Turn whatever the AI sent into safe ideas that only use clips and songs that exist. */
export function sanitizeIdeas(raw: unknown, clips: ClipSidecar[], tracks: MusicTrack[], format: ExportFormat): ReelIdea[] {
  const arr: any[] = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.ideas) ? (raw as any).ideas : [];
  const known = new Set(clips.map((c) => c.id));
  const trackIds = new Set(tracks.map((t) => t.id));
  const styles = new Set(STYLES.map((s) => s.id));
  const out: ReelIdea[] = [];
  for (const r of arr.slice(0, 8)) {
    const clipIds = (Array.isArray(r?.clipIds) ? r.clipIds : []).filter((x: unknown): x is string => typeof x === 'string' && known.has(x));
    const title = str(r?.title, 60);
    if (!title || !clipIds.length) continue;
    const bpm = Array.isArray(r?.music?.bpm) && r.music.bpm.length === 2 && r.music.bpm.every((x: unknown) => Number.isFinite(x)) ? ([Math.max(50, Math.min(220, r.music.bpm[0])), Math.max(50, Math.min(220, r.music.bpm[1]))] as [number, number]) : undefined;
    out.push({
      id: id(),
      title,
      concept: str(r?.concept, 240),
      hook: hookText(r?.hook),
      endText: str(r?.endText, 60) || undefined,
      imageIdea: str(r?.imageIdea, 160),
      imageSearch: str(r?.imageSearch, 60),
      captions: (Array.isArray(r?.captions) ? r.captions : []).map((x: unknown) => str(x, 60)).filter(Boolean).slice(0, 14),
      styleId: styles.has(r?.styleId) ? r.styleId : 'story',
      format: format.id as FormatId,
      clipIds: [...new Set<string>(clipIds)].slice(0, 20),
      music: {
        trackId: typeof r?.music?.trackId === 'string' && trackIds.has(r.music.trackId) ? r.music.trackId : undefined,
        mood: str(r?.music?.mood, 80),
        bpm,
        search: str(r?.music?.search, 60) || str(r?.music?.mood, 60) || 'gaming montage',
      },
      postCaption: str(r?.postCaption, 400) || undefined,
      why: str(r?.why, 240),
      source: 'ai',
    });
  }
  return out;
}

export function ideasPrompt(o: { clips: ClipSidecar[]; tracks: MusicTrack[]; format: ExportFormat; request: string; count: number }): string {
  const clipRows = byScore(o.clips)
    .slice(0, 80)
    .map((c) => ({ id: c.id, hero: c.hero, kills: kills(c), tags: plainTags(c).slice(0, 6), score: c.score, rating: c.rating, map: c.match?.map, seconds: Math.round(c.durationMs / 1000) }));
  const songs = o.tracks
    .filter((t) => t.analysis)
    .slice(0, 40)
    .map((t) => ({ trackId: t.id, title: t.title, artist: t.artist, bpm: Math.round(t.analysis!.bpm), energy: Math.round(t.analysis!.energy * 100) / 100, hasDrop: t.analysis!.drops.length > 0, license: t.license }));
  const n = Math.max(3, Math.round(o.format.idealSeconds[1] / SECONDS_PER_CLIP));
  return [
    `Come up with ${o.count} different ideas for ${o.format.label} reels (${o.format.idealSeconds[0]} to ${o.format.idealSeconds[1]} seconds) from my Marvel Rivals clips.`,
    REFERENCE_STYLE,
    'Make each idea a different angle (a hero spotlight, a joke, a hot take, a challenge, a comeback story...). Write hooks and captions that sound like a real creator, not an ad. Keep each caption line to 6 words or fewer. No slurs, nothing mean about real people.',
    `Pick about ${n} clips per idea from the list, ordered so it builds: the best play last. Only use clip ids from the list.`,
    `Edit styles to choose from: ${STYLES.map((s) => `${s.id} (${s.description})`).join('; ')}.`,
    songs.length ? `My songs (use a trackId only if it really fits): ${JSON.stringify(songs)}` : 'I have no songs yet, so describe the music to search for.',
    'For music.search, give 2 to 4 words to search royalty-free music with (genre and mood, no artist names). For imageSearch, give 2 to 4 words to search free pictures for the hook card.',
    o.request ? `My own idea or request: "${o.request.slice(0, 400)}"` : '',
    `Clips: ${JSON.stringify(clipRows)}`,
    'Reply as JSON: {"ideas":[{"title":"","concept":"one sentence","hook":"hook card text: one line, or 2 to 4 very short lines separated by \\n that show one after another","endText":"big text over the last seconds (optional)","imageIdea":"what the hook picture shows","imageSearch":"","captions":["",""],"styleId":"","clipIds":[""],"music":{"trackId":"optional","mood":"","bpm":[120,140],"search":""},"postCaption":"post text with 4 to 6 hashtags","why":"why it would do well"}]}',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function aiIdeas(ai: AiClient | undefined, o: { clips: ClipSidecar[]; tracks: MusicTrack[]; format: ExportFormat; request: string; count: number }): Promise<ReelIdea[]> {
  if (!ai) throw new Error('Sign in with Claude or ChatGPT under Settings to get AI ideas.');
  if (!o.clips.some((c) => kills(c) > 0)) throw new Error('Record a few clips with kills first.');
  const r = await ai.ask({ prompt: ideasPrompt(o), system: 'You help a Marvel Rivals creator plan short gameplay edits. Follow the requested JSON shape exactly.', expectJson: true, timeoutMs: 180_000 });
  const ideas = sanitizeIdeas(r.json, o.clips, o.tracks, o.format);
  if (!ideas.length) throw new Error('The AI did not come back with usable ideas. Try again.');
  return ideas;
}
