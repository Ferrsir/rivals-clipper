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
  /** "start the song at 0:56": seconds into the song where the reel starts. */
  songStart?: number;
  /** "end the song at 1:12": seconds into the song where the reel ends. */
  songEnd?: number;
}

const TIME = String.raw`(\d{1,2}:\d{2}(?:\.\d+)?|\d{1,3}(?:\.\d+)?\s*(?:s|secs?|seconds?)\b)`;
const START_RE = new RegExp(String.raw`\b(?:(?:start|begin)\w*\s+(?:the\s+)?(?:song|music|track|audio)\s+(?:at|from)|(?:song|music|track|audio)\s+(?:from|starting at|starts at))\s+` + TIME, 'i');
const END_RE = new RegExp(String.raw`\b(?:(?:end|stop|finish)\w*\s+(?:the\s+)?(?:song|music|track|audio|reel|video|it)\s+(?:at|on)|(?:song|music|track|audio)\s+(?:until|till|to|ending at|ends at))\s+` + TIME, 'i');

const toSeconds = (v: string) => {
  const m = v.match(/^(\d+):(\d{2}(?:\.\d+)?)$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : parseFloat(v);
};

/** Song times named in a prompt, and the prompt with them removed (so "at 56 seconds" isn't read as the reel length). */
export function songTimes(text: string): { start?: number; end?: number; rest: string } {
  let rest = text;
  let start: number | undefined;
  let end: number | undefined;
  const a = rest.match(START_RE);
  if (a) { start = toSeconds(a[1].trim()); rest = rest.replace(a[0], ' '); }
  const b = rest.match(END_RE);
  if (b) { end = toSeconds(b[1].trim()); rest = rest.replace(b[0], ' '); }
  const ok = (v?: number) => (v !== undefined && Number.isFinite(v) && v >= 0 && v < 3600 ? v : undefined);
  return { start: ok(start), end: ok(end), rest };
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
  const times = songTimes(text);
  const t = times.rest.toLowerCase();
  return {
    seconds: requestedSeconds(times.rest),
    songStart: times.start,
    songEnd: times.end,
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
