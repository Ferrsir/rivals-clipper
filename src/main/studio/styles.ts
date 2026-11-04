// Edit-style recipes. A style is plain data, so the AI can propose changes ("more shake, slower intro")
// and sanitizeStyle() keeps whatever comes back inside safe limits.

import type { BeatPulse, Mix, StyleRecipe } from '../../shared/studio';

const story: StyleRecipe = {
  id: 'story',
  name: 'Story edit',
  description: 'Hook card, story or lyric captions, 3 to 7 second clips cut on the beat, hero punched in, white flashes on cuts, afterimage trails on the big kill and a fade to black. Modelled on the reference edits.',
  beatSync: true,
  speedRange: [0.85, 1.2],
  cruiseSpeed: 1,
  leadIn: [2, 4.5],
  tail: [0.8, 2.5],
  slowmo: { on: true, speed: 0.45, before: 0.25, after: 0.35, smooth: 'blend', gameVolume: 0.5, scope: 'hero' },
  zoom: { on: true, amount: 1.08, attack: 0.06, release: 0.4, onBeats: 'none', beatAmount: 1.02 },
  shake: { on: true, amount: 0.006, duration: 0.25, frequency: 14, onBeats: 'none', beatAmount: 0.002 },
  flash: { on: true, strength: 0.6, duration: 0.18, onKills: false, onDrop: true, onCuts: true },
  rgbSplit: { on: false, amount: 4, duration: 0.1 },
  motionBlur: { on: false, minSpeed: 1.5 },
  grade: { contrast: 1.08, saturation: 1.15, brightness: 0, gamma: 1, vignette: 0.15, sharpen: 0.3 },
  echo: { on: true, strength: 0.65, onSlowmo: true },
  transition: 'flash',
  fadeOut: 1,
  captions: { position: 'bottom', size: 0.062, uppercase: false, beatsPerLine: 4 },
  impactSound: 0,
  mix: { game: 0.6, mic: 1, music: 0.95, duck: true },
};

const velocity: StyleRecipe = {
  id: 'velocity',
  name: 'Velocity',
  description: 'Speeds up the run-in, drops to slow-mo on every kill and lands it on the beat, with a zoom punch, shake and flash. Built for TikTok and Shorts.',
  beatSync: true,
  speedRange: [0.5, 2.2],
  cruiseSpeed: 1.2,
  leadIn: [0.8, 2.6],
  tail: [0.25, 0.9],
  slowmo: { on: true, speed: 0.35, before: 0.3, after: 0.25, smooth: 'blend', gameVolume: 0.3, scope: 'all' },
  zoom: { on: true, amount: 1.16, attack: 0.05, release: 0.32, onBeats: 'downbeats', beatAmount: 1.035 },
  shake: { on: true, amount: 0.012, duration: 0.3, frequency: 17, onBeats: 'none', beatAmount: 0.004 },
  flash: { on: true, strength: 0.5, duration: 0.14, onKills: true, onDrop: true, onCuts: false },
  rgbSplit: { on: true, amount: 7, duration: 0.12 },
  motionBlur: { on: true, minSpeed: 1.5 },
  grade: { contrast: 1.12, saturation: 1.2, brightness: 0, gamma: 1, vignette: 0.25, sharpen: 0.35 },
  echo: { on: true, strength: 0.6, onSlowmo: true },
  transition: 'flash',
  fadeOut: 0.4,
  captions: { position: 'top', size: 0.065, uppercase: true, beatsPerLine: 4 },
  impactSound: 0.5,
  mix: { game: 0.55, mic: 1, music: 0.9, duck: true },
};

const beatCuts: StyleRecipe = {
  id: 'beat-cuts',
  name: 'Beat cuts',
  description: 'Real-time footage, every kill and cut on the beat, a short punch and shake on kills. Clean and fast, good for Reels.',
  beatSync: true,
  speedRange: [0.85, 1.25],
  cruiseSpeed: 1,
  leadIn: [0.9, 2.4],
  tail: [0.3, 1.0],
  slowmo: { on: false, speed: 0.5, before: 0.2, after: 0.2, smooth: 'none', gameVolume: 0.6, scope: 'all' },
  zoom: { on: true, amount: 1.1, attack: 0.04, release: 0.25, onBeats: 'none', beatAmount: 1.03 },
  shake: { on: true, amount: 0.007, duration: 0.22, frequency: 20, onBeats: 'none', beatAmount: 0.003 },
  flash: { on: false, strength: 0.35, duration: 0.1, onKills: true, onDrop: true, onCuts: false },
  rgbSplit: { on: false, amount: 5, duration: 0.1 },
  motionBlur: { on: false, minSpeed: 1.5 },
  grade: { contrast: 1.06, saturation: 1.1, brightness: 0, gamma: 1, vignette: 0.15, sharpen: 0.25 },
  echo: { on: false, strength: 0.5, onSlowmo: true },
  transition: 'cut',
  fadeOut: 0.3,
  captions: { position: 'bottom', size: 0.06, uppercase: false, beatsPerLine: 4 },
  impactSound: 0.3,
  mix: { game: 0.7, mic: 1, music: 0.8, duck: true },
};

const cinematic: StyleRecipe = {
  id: 'cinematic',
  name: 'Cinematic',
  description: 'Gentle slow-mo on kills, no shake, dips between clips and a soft grade. Suits YouTube montages.',
  beatSync: true,
  speedRange: [0.8, 1.15],
  cruiseSpeed: 1,
  leadIn: [1.5, 4],
  tail: [0.6, 1.6],
  slowmo: { on: true, speed: 0.5, before: 0.5, after: 0.6, smooth: 'blend', gameVolume: 0.5, scope: 'all' },
  zoom: { on: false, amount: 1.06, attack: 0.15, release: 0.6, onBeats: 'none', beatAmount: 1.02 },
  shake: { on: false, amount: 0.004, duration: 0.3, frequency: 10, onBeats: 'none', beatAmount: 0.002 },
  flash: { on: false, strength: 0.25, duration: 0.2, onKills: false, onDrop: true, onCuts: false },
  rgbSplit: { on: false, amount: 3, duration: 0.15 },
  motionBlur: { on: false, minSpeed: 1.5 },
  grade: { contrast: 1.05, saturation: 1.05, brightness: 0, gamma: 1, vignette: 0.35, sharpen: 0.2 },
  echo: { on: false, strength: 0.4, onSlowmo: true },
  transition: 'dip',
  fadeOut: 1.2,
  captions: { position: 'bottom', size: 0.05, uppercase: false, beatsPerLine: 8 },
  impactSound: 0,
  mix: { game: 0.9, mic: 1, music: 0.6, duck: true },
};

const raw: StyleRecipe = {
  id: 'raw',
  name: 'Raw highlights',
  description: 'Your plays as they happened, trimmed tight, no effects. Music optional. Good for YouTube compilations with commentary.',
  beatSync: false,
  speedRange: [1, 1],
  cruiseSpeed: 1,
  leadIn: [2, 5],
  tail: [1, 2.5],
  slowmo: { on: false, speed: 0.5, before: 0.3, after: 0.3, smooth: 'none', gameVolume: 1, scope: 'all' },
  zoom: { on: false, amount: 1.08, attack: 0.05, release: 0.3, onBeats: 'none', beatAmount: 1.02 },
  shake: { on: false, amount: 0.006, duration: 0.25, frequency: 15, onBeats: 'none', beatAmount: 0.002 },
  flash: { on: false, strength: 0.3, duration: 0.12, onKills: false, onDrop: false, onCuts: false },
  rgbSplit: { on: false, amount: 4, duration: 0.1 },
  motionBlur: { on: false, minSpeed: 1.5 },
  grade: { contrast: 1, saturation: 1, brightness: 0, gamma: 1, vignette: 0, sharpen: 0.15 },
  echo: { on: false, strength: 0.4, onSlowmo: true },
  transition: 'cut',
  fadeOut: 0.5,
  captions: { position: 'bottom', size: 0.05, uppercase: false, beatsPerLine: 8 },
  impactSound: 0,
  mix: { game: 1, mic: 1, music: 0.35, duck: true },
};

export const STYLES: StyleRecipe[] = [story, velocity, beatCuts, cinematic, raw];

export function getStyle(id: string): StyleRecipe {
  return clone(STYLES.find((s) => s.id === id) ?? velocity);
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

const num = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const PULSES: readonly BeatPulse[] = ['none', 'downbeats', 'all'];
const range = (v: unknown, lo: number, hi: number, fb: [number, number]): [number, number] => {
  const a = Array.isArray(v) ? v : fb;
  const x = num(a[0], lo, hi, fb[0]);
  const y = num(a[1], lo, hi, fb[1]);
  return x <= y ? [x, y] : [y, x];
};

export function sanitizeMix(m: Partial<Mix> | undefined, base: Mix): Mix {
  const v = m ?? {};
  return {
    game: num(v.game, 0, 2, base.game),
    mic: num(v.mic, 0, 3, base.mic),
    music: num(v.music, 0, 2, base.music),
    duck: bool(v.duck, base.duck),
  };
}

/** Clamp every field to a safe range, filling gaps from `base`. Accepts untrusted input (AI replies, old project files). */
export function sanitizeStyle(input: unknown, base: StyleRecipe = velocity): StyleRecipe {
  const s = (input && typeof input === 'object' ? input : {}) as Partial<StyleRecipe> & Record<string, any>;
  const sm = (s.slowmo ?? {}) as Partial<StyleRecipe['slowmo']>;
  const z = (s.zoom ?? {}) as Partial<StyleRecipe['zoom']>;
  const sh = (s.shake ?? {}) as Partial<StyleRecipe['shake']>;
  const fl = (s.flash ?? {}) as Partial<StyleRecipe['flash']>;
  const rgb = (s.rgbSplit ?? {}) as Partial<StyleRecipe['rgbSplit']>;
  const mb = (s.motionBlur ?? {}) as Partial<StyleRecipe['motionBlur']>;
  const g = (s.grade ?? {}) as Partial<StyleRecipe['grade']>;
  const ec = (s.echo ?? {}) as Partial<StyleRecipe['echo']>;
  const cap = (s.captions ?? {}) as Partial<StyleRecipe['captions']>;
  const out: StyleRecipe = {
    id: typeof s.id === 'string' && s.id ? s.id.slice(0, 40) : base.id,
    name: typeof s.name === 'string' && s.name ? s.name.slice(0, 60) : base.name,
    description: typeof s.description === 'string' ? s.description.slice(0, 400) : base.description,
    beatSync: bool(s.beatSync, base.beatSync),
    speedRange: range(s.speedRange, 0.25, 4, base.speedRange),
    cruiseSpeed: num(s.cruiseSpeed, 0.5, 3, base.cruiseSpeed),
    leadIn: range(s.leadIn, 0.3, 8, base.leadIn),
    tail: range(s.tail, 0.1, 5, base.tail),
    slowmo: {
      on: bool(sm.on, base.slowmo.on),
      speed: num(sm.speed, 0.15, 0.9, base.slowmo.speed),
      before: num(sm.before, 0, 1.5, base.slowmo.before),
      after: num(sm.after, 0, 1.5, base.slowmo.after),
      smooth: pick(sm.smooth, ['none', 'blend', 'motion'] as const, base.slowmo.smooth),
      gameVolume: num(sm.gameVolume, 0, 1, base.slowmo.gameVolume),
      scope: pick(sm.scope, ['all', 'hero'] as const, base.slowmo.scope),
    },
    zoom: {
      on: bool(z.on, base.zoom.on),
      amount: num(z.amount, 1, 1.6, base.zoom.amount),
      attack: num(z.attack, 0.01, 0.5, base.zoom.attack),
      release: num(z.release, 0.05, 2, base.zoom.release),
      onBeats: pick(z.onBeats, PULSES, base.zoom.onBeats),
      beatAmount: num(z.beatAmount, 1, 1.2, base.zoom.beatAmount),
    },
    shake: {
      on: bool(sh.on, base.shake.on),
      amount: num(sh.amount, 0, 0.04, base.shake.amount),
      duration: num(sh.duration, 0.05, 1.5, base.shake.duration),
      frequency: num(sh.frequency, 2, 40, base.shake.frequency),
      onBeats: pick(sh.onBeats, PULSES, base.shake.onBeats),
      beatAmount: num(sh.beatAmount, 0, 0.02, base.shake.beatAmount),
    },
    flash: {
      on: bool(fl.on, base.flash.on),
      strength: num(fl.strength, 0, 1, base.flash.strength),
      duration: num(fl.duration, 0.03, 0.6, base.flash.duration),
      onKills: bool(fl.onKills, base.flash.onKills),
      onDrop: bool(fl.onDrop, base.flash.onDrop),
      onCuts: bool(fl.onCuts, base.flash.onCuts),
    },
    rgbSplit: {
      on: bool(rgb.on, base.rgbSplit.on),
      amount: Math.round(num(rgb.amount, 0, 30, base.rgbSplit.amount)),
      duration: num(rgb.duration, 0.03, 0.6, base.rgbSplit.duration),
    },
    motionBlur: { on: bool(mb.on, base.motionBlur.on), minSpeed: num(mb.minSpeed, 1.1, 4, base.motionBlur.minSpeed) },
    grade: {
      contrast: num(g.contrast, 0.7, 1.6, base.grade.contrast),
      saturation: num(g.saturation, 0, 2, base.grade.saturation),
      brightness: num(g.brightness, -0.3, 0.3, base.grade.brightness),
      gamma: num(g.gamma, 0.6, 1.6, base.grade.gamma),
      vignette: num(g.vignette, 0, 1, base.grade.vignette),
      sharpen: num(g.sharpen, 0, 1.5, base.grade.sharpen),
    },
    echo: { on: bool(ec.on, base.echo.on), strength: num(ec.strength, 0, 0.95, base.echo.strength), onSlowmo: bool(ec.onSlowmo, base.echo.onSlowmo) },
    transition: pick(s.transition, ['cut', 'flash', 'dip', 'whip'] as const, base.transition),
    fadeOut: num(s.fadeOut, 0, 4, base.fadeOut),
    captions: {
      position: pick(cap.position, ['top', 'middle', 'bottom'] as const, base.captions.position),
      size: num(cap.size, 0.03, 0.12, base.captions.size),
      uppercase: bool(cap.uppercase, base.captions.uppercase),
      beatsPerLine: Math.round(num(cap.beatsPerLine, 1, 32, base.captions.beatsPerLine)),
    },
    impactSound: num(s.impactSound, 0, 1, base.impactSound),
    mix: sanitizeMix(s.mix, base.mix),
  };
  if (out.cruiseSpeed < out.speedRange[0]) out.cruiseSpeed = out.speedRange[0];
  if (out.cruiseSpeed > out.speedRange[1]) out.cruiseSpeed = out.speedRange[1];
  return out;
}
