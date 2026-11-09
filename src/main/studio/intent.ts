// What a reel prompt asks for, read straight from the words so it never depends on the AI noticing:
// "heres the clip of gojo vs toji ... put his icon on gojo ... subtitles ... ai voices ...
// a reel thats about 20-30 seconds ... to the song aizo".

import path from 'node:path';
import type { MusicTrack, StyleRecipe } from '../../shared/studio';
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
  /** "till gojo goes 'exactly'": the word the hook clip ends on. */
  untilWord?: string;
  /** "let the last clip play out and fade with the music". */
  playOut: boolean;
}

const SAY = String.raw`(?:goes|says|said|say|yells|shouts|screams|is like)`;
/** "till gojo goes "exactly"", "until he says exactly", "cut it at 'exactly'", "ends on the word exactly". */
export function untilWord(text: string): string | undefined {
  const t = text.replace(/\s+/g, ' ');
  const quoted = String.raw`["“'‘]([^"”'’]{2,40})["”'’]`;
  const patterns = [
    new RegExp(String.raw`\b(?:till|until|untill|til|up to)\s+(?:[\w']+\s+){0,3}?${SAY}\s+` + quoted, 'i'),
    new RegExp(String.raw`\b(?:till|until|untill|til|up to)\s+(?:[\w']+\s+){0,3}?${SAY}\s+([a-z']{2,20})\b`, 'i'),
    new RegExp(String.raw`\b(?:cut|end|stop)\w*\s+(?:it\s+|the clip\s+|the hook\s+)?(?:at|on|after)\s+(?:the word\s+)?` + quoted, 'i'),
  ];
  for (const [k, re] of patterns.entries()) {
    const m = t.match(re);
    // "till the music goes quiet" is about the song, not a line someone says.
    if (m && k < 2 && /\b(?:music|song|track|beat|bass|drop|it)\b/i.test(m[0].slice(0, m[0].length - m[1].length))) continue;
    if (m && m[1].trim()) return m[1].trim().replace(/[.,!?]+$/, '');
  }
  return undefined;
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
    untilWord: untilWord(times.rest),
    playOut: /\b(play(?:s|ing)? (?:it |that |the clip )?out|finish(?:es)? out|let (?:the |that )?(?:last |final )?clip (?:finish|play|run)|(?:last|final) clip (?:fades?|plays? out)|fades? out with the (?:music|song))\b/.test(t),
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

/**
 * Effect rules a prompt states plainly ("no slow-mo", "no shake", "slow-mo on every kill", "just hard cuts",
 * "clean, no effects"). Applied to the style after the AI's plan, so they hold whatever it picked.
 */
export function styleFromPrompt(text: string, style: StyleRecipe): { style: StyleRecipe; changes: string[] } {
  const t = ` ${text.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ')} `;
  const s: StyleRecipe = JSON.parse(JSON.stringify(style));
  const changes: string[] = [];
  const NO = String.raw`(?:no|without|zero|remove|drop|turn off|don'?t (?:add|use|want)|dont (?:add|use|want)|get rid of|less)\s+(?:any\s+|the\s+)?`;
  const no = (what: string) => new RegExp(NO + what).test(t);
  const SLOW = String.raw`(?:slow[- ]?mo(?:tion)?s?|slow motion|slowdowns?)`;
  const clean = no(String.raw`(?:effects?|fx|edits? on it|extra stuff)`) || /\b(clean|raw|plain|simple) (edit|cut|reel|montage)\b|\bjust the (gameplay|clips)\b/.test(t);
  if (clean) {
    s.slowmo.on = false;
    s.zoom.on = false;
    s.shake.on = false;
    s.flash.on = false;
    s.rgbSplit.on = false;
    s.echo.on = false;
    s.motionBlur.on = false;
    s.transition = 'cut';
    s.speedRange = [Math.max(0.9, Math.min(s.speedRange[0], 1)), Math.min(1.15, Math.max(s.speedRange[1], 1))];
    s.cruiseSpeed = 1;
    s.impactSound = 0;
    changes.push('no effects (plain cuts on the beat)');
  }
  if (no(SLOW) && s.slowmo.on) { s.slowmo.on = false; changes.push('no slow-mo'); }
  else if (new RegExp(SLOW + String.raw`\s+(?:on|for|at)\s+(?:every|all|each)(?: the)? kills?`).test(t) || /\b(every|each|all) kills? (in|with|gets?) slow[- ]?mo/.test(t)) {
    s.slowmo.on = true; s.slowmo.scope = 'all'; changes.push('slow-mo on every kill');
  } else if (!clean && new RegExp(String.raw`\b(?:add|with|use|more|some)\s+(?:some\s+)?` + SLOW).test(t) && !s.slowmo.on) {
    s.slowmo.on = true; changes.push('slow-mo on the big play');
  }
  if (no(String.raw`(?:zooms?|zoom[- ]ins?|punch[- ]?ins?)`) && s.zoom.on) { s.zoom.on = false; changes.push('no zoom'); }
  if (no(String.raw`(?:shakes?|camera shake|screen shake)`) && s.shake.on) { s.shake.on = false; changes.push('no shake'); }
  if (no(String.raw`(?:flash(?:es)?|white flash(?:es)?)`) && (s.flash.on || s.transition === 'flash')) {
    s.flash.on = false;
    if (s.transition === 'flash') s.transition = 'cut';
    changes.push('no flashes');
  }
  if (no(String.raw`(?:rgb|chromatic|glitch)`) && s.rgbSplit.on) { s.rgbSplit.on = false; changes.push('no RGB split'); }
  if (no(String.raw`(?:trails?|ghosting|afterimages?|echo)`) && s.echo.on) { s.echo.on = false; changes.push('no trails'); }
  if (no(String.raw`(?:blur|motion blur)`) && s.motionBlur.on) { s.motionBlur.on = false; changes.push('no motion blur'); }
  if (no(String.raw`(?:transitions?)`) || /\b(hard|straight|just|only) cuts\b/.test(t)) {
    if (s.transition !== 'cut') { s.transition = 'cut'; changes.push('hard cuts between clips'); }
  }
  if (no(String.raw`(?:speed ?ramps?|speed[- ]?ups?|speeding up|sped up|velocity|speed changes?)`) || /\b(real[- ]?time|normal speed)\b/.test(t)) {
    s.speedRange = [Math.max(0.95, Math.min(s.speedRange[0], 1)), Math.min(1.05, Math.max(s.speedRange[1], 1))];
    s.cruiseSpeed = 1;
    s.motionBlur.on = false;
    changes.push('normal speed');
  }
  if (no(String.raw`(?:hit ?sounds?|impact sounds?|sound effects?|sfx)`) && s.impactSound > 0) { s.impactSound = 0; changes.push('no hit sounds'); }
  if (no(String.raw`(?:fade|fade out|fade to black)`) && s.fadeOut > 0) { s.fadeOut = 0; changes.push('no fade at the end'); }
  return { style: s, changes };
}
