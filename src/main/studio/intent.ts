// What a reel prompt asks for, read straight from the words so it never depends on the AI noticing:
// "heres the clip of gojo vs toji ... put his icon on gojo ... subtitles ... ai voices ...
// a reel thats about 20-30 seconds ... to the song aizo".

import path from 'node:path';
import type { MusicTrack } from '../../shared/studio';
import { requestedSeconds } from './fit';

export interface PromptIntent {
  seconds?: number;
  /** The song named in the prompt, as written. */
  song?: string;
  subtitles: boolean;
  voices: boolean;
  /** A picture should go over someone's face. */
  faceOverlay: boolean;
}

const clean = (s: string) => s.replace(/^["'“”‘’\s]+|["'“”‘’\s.,!?;:]+$/g, '').trim();

/** "to the song aizo", "song: Aizo by King Gnu", "music is \"Aizo\"", "set it to aizo". */
export function songFromPrompt(text: string): string | undefined {
  const t = text.replace(/\s+/g, ' ');
  const patterns = [
    /\b(?:song|track|music|audio|sound)\s*(?:is|=|:|called|named)\s*["“']?([^"”'\n,.;!?]{2,60})/i,
    /\b(?:to|with|over|on|using|use)\s+(?:the\s+)?(?:song|track|music|audio|sound)\s+["“']?([^"”'\n,.;!?]{2,60})/i,
    /\b(?:to|with|over)\s+["“]([^"”]{2,60})["”]/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    // Stop at the next clause: "aizo and make it 30 seconds", "aizo etc".
    const name = clean(m[1].split(/\s+(?:and|but|then|etc|with|please|plz|so|that|for|in|at)\b/i)[0]);
    if (name && !/^(a|the|some|any|good|nice|my|your|it|this|that)$/i.test(name)) return name;
  }
  return undefined;
}

export function readIntent(text: string): PromptIntent {
  const t = text.toLowerCase();
  return {
    seconds: requestedSeconds(text),
    song: songFromPrompt(text),
    subtitles: /\b(subtitles?|subs|captions?|closed captions)\b/.test(t),
    voices: /\b(ai voices?|voice ?overs?|voiced|tts|text to speech|dub(bed|bing)?|narrat\w*)\b|\bvoices? for\b|\b(have|make|let) (them|him|her|both|the characters?) (talk|speak|say|argue|trash talk)|\bthem talking\b/.test(t),
    faceOverlay: /\b(icon|picture|pic|image|photo|logo|sticker|emoji|face ?swap)\b/.test(t) && /\b(on|over)\s+(?!the song|the track|the music)\w+/.test(t),
  };
}

const norm = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, '')
    .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g, ' ')
    .trim();

/** How well a track matches a typed song name, 0..1. "aizo" matches "King Gnu - AIZO (Official).mp3". */
export function songScore(track: MusicTrack, name: string): number {
  const want = norm(name);
  if (!want) return 0;
  const words = want.split(' ');
  const fields = [track.title, track.artist ?? '', path.basename(track.file), `${track.artist ?? ''} ${track.title}`].map(norm);
  let best = 0;
  for (const f of fields) {
    if (!f) continue;
    if (f === want) best = Math.max(best, 1);
    else if (` ${f} `.includes(` ${want} `)) best = Math.max(best, 0.9);
    else if (f.includes(want)) best = Math.max(best, 0.75);
    const have = new Set(f.split(' '));
    const hit = words.filter((w) => have.has(w)).length / words.length;
    best = Math.max(best, hit * 0.8);
  }
  return best;
}

/** The track in your music folder that a typed song name means, if any. */
export function findSong(tracks: MusicTrack[], name: string | undefined): MusicTrack | undefined {
  if (!name) return undefined;
  let best: MusicTrack | undefined;
  let score = 0;
  for (const t of tracks) {
    const s = songScore(t, name);
    if (s > score) {
      score = s;
      best = t;
    }
  }
  return score >= 0.6 ? best : undefined;
}
