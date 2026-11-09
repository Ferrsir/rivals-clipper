// Ferris's hand-made Deadpool x Wild Side reel (2026-11-09) needed things the Studio couldn't do.
// These are the tools that let it make that kind of TikTok on its own (notes/studio-gaps-deadpool-reel.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MusicAnalysis, ReelClip } from '../src/shared/studio';
import { JUMP, plan } from '../src/main/studio/planner';
import { getStyle } from '../src/main/studio/styles';
import { clipPostFilters, musicEnvelopeExpr, musicEnvelopeFor } from '../src/main/studio/render';
import { clipEdits, sanitizeProject, createProject } from '../src/main/studio/projects';
import { hookEnd, refineWordEnds, wavSamples } from '../src/main/studio/speech';
import { readIntent, untilWord } from '../src/main/studio/intent';
import { dropWhileDead } from '../src/main/studio/feed-rows';
import { DEATH_MIN, DEATH_TEMPLATE, deathScore } from '../src/main/studio/clip-filter';

function grid(bpm = 134.4, seconds = 120): MusicAnalysis {
  const step = 60 / bpm;
  const beats = Array.from({ length: Math.floor(seconds / step) }, (_, i) => Math.round((0.2 + i * step) * 1000) / 1000);
  return { version: 1, durationSec: seconds, bpm, beats, downbeats: beats.filter((_, i) => i % 4 === 0), beatEnergy: beats.map(() => 0.5), drops: [beats[32]], energy: 0.7, confidence: 0.9, peaks: [] };
}
function clip(uid: string, hits: number[], extra: Partial<ReelClip> = {}): ReelClip {
  return { uid, clipId: uid, videoFile: `/c/${uid}.mp4`, kills: hits.length, score: 10, tags: [], durationSec: 9, width: 2584, height: 1080, fps: 60, hasMic: false, hits, in: 0, out: 9, useMic: false, cropX: 0.5, cropY: 0.5, cropZoom: 1, ...extra };
}
const style = { ...getStyle('velocity'), slowmo: { ...getStyle('velocity').slowmo, on: false } };

test('a slow double is cut into two quick pieces instead of sped through', () => {
  const c = clip('dbl', [2.45, 6.05]);
  const tl = plan({ clips: [c], style, fps: 60, analysis: grid(), musicStart: 0 });
  const gaps = tl.segments.filter((s) => s.kind === 'gap');
  assert.equal(gaps.length, 2, 'one jump cut between the kills');
  // The walk between the kills is skipped, not played fast.
  const skipped = gaps[1].src[0] - gaps[0].src[1];
  assert.ok(skipped > 1, `skips ${skipped}s`);
  assert.ok(gaps.every((g) => g.speed <= style.speedRange[1] + 1e-3));
  assert.ok(gaps[0].src[1] - gaps[0].src[0] <= JUMP.after + 1e-3);
  assert.equal(tl.kills.length, 2);
  // Turned off, the old behaviour comes back.
  const off = plan({ clips: [{ ...c, jumpCut: false }], style, fps: 60, analysis: grid(), musicStart: 0 });
  assert.equal(off.segments.filter((s) => s.kind === 'gap').length, 1);
});

test('a hook keeps every frame, holds its last one for about a beat, and the montage starts on a beat', () => {
  const an = grid();
  const hook = clip('hook', [], { external: true, in: 1, out: 14.19, durationSec: 20, holdBeats: 1, musicLevel: 0.16 });
  const tl = plan({ clips: [hook, clip('k1', [2.4])], style, fps: 60, analysis: an, musicStart: 0 });
  const plain = tl.segments.find((s) => s.kind === 'plain')!;
  assert.ok(Math.abs(plain.src[1] - 14.19) < 1e-3 && Math.abs(plain.src[0] - 1) < 0.02, 'the hook is not trimmed to a beat');
  const hold = tl.segments.find((s) => s.kind === 'hold')!;
  assert.equal(hold.speed, 0);
  const beat = 60 / an.bpm;
  const len = hold.out[1] - hold.out[0];
  assert.ok(len > 0.4 * beat && len < 1.6 * beat, `hold ${len}`);
  assert.ok(tl.beats.some((b) => Math.abs(b - hold.out[1]) < 1 / 60 + 1e-3), 'the cut after the hold is on a beat');
  assert.ok(Math.abs(tl.clips[0].out[1] - hold.out[1]) < 1e-6, 'the hold belongs to the hook');
});

test('a play-out ending lets the last clip run at real speed past its kill', () => {
  const last = clip('ult', [2.9], { out: 9 });
  const cut = plan({ clips: [clip('a', [2.4]), last], style, fps: 60, analysis: grid(), musicStart: 0 });
  const out = plan({ clips: [clip('a', [2.4]), last], style, fps: 60, analysis: grid(), musicStart: 0, ending: { mode: 'play-out', fade: 1.8 } });
  const tail = out.segments.at(-1)!;
  assert.equal(tail.kind, 'tail');
  assert.ok(Math.abs(tail.speed - 1) < 0.02);
  assert.ok(Math.abs(tail.src[1] - 9) < 0.02, 'runs to the end of the clip');
  assert.ok(out.duration > cut.duration + 2);
  const capped = plan({ clips: [last], style, fps: 60, analysis: grid(), musicStart: 0, ending: { mode: 'play-out', fade: 1.8, maxTail: 2 } });
  assert.ok(capped.segments.at(-1)!.src[1] <= 2.9 + 2 + 0.02);
});

test('the music sits quietly under the hook and comes in full after it; audio jumps drop it out', () => {
  const an = grid();
  const hook = clip('hook', [], { external: true, in: 0, out: 6, durationSec: 8, holdBeats: 1, musicLevel: 0.16 });
  const tl = plan({ clips: [hook, clip('k1', [2.4])], style, fps: 60, analysis: an, musicStart: 0 });
  const env = musicEnvelopeFor(tl, [hook, clip('k1', [2.4])], [{ at: 7, length: 0.45 }]);
  assert.equal(env.levels.length, 1);
  assert.equal(env.levels[0].from, 0);
  assert.equal(env.levels[0].to, tl.clips[0].out[1], 'quiet through the hold too');
  const expr = musicEnvelopeExpr(env);
  const at = (t: number) => Function('t', 'between', 'max', `return ${expr.replace(/if\(/g, 'iff(')}`.replace('return ', 'const iff=(c,a,b)=>c?a:b; return '))(t, (x: number, a: number, b: number) => (x >= a && x <= b ? 1 : 0), Math.max);
  assert.ok(Math.abs(at(1) - 0.16) < 1e-6);
  assert.ok(Math.abs(at(tl.clips[0].out[1] + 0.2) - 1) < 1e-6);
  assert.ok(tl.duration > 7.6); assert.ok(at(7.2) === 0, 'silent inside the audio jump');
  assert.ok(Math.abs(at(7.6) - 1) < 1e-6);
  assert.equal(musicEnvelopeExpr({ levels: [], cuts: [] }), '');
});

test('clip fades and loudness become filters on that clip only', () => {
  assert.deepEqual(clipPostFilters({}, 3), { v: '', a: '' });
  const f = clipPostFilters({ fadeIn: 0.3, fadeOut: 0.5, normalize: true }, 3);
  assert.match(f.v, /fade=t=in:st=0:d=0.3,fade=t=out:st=2.5:d=0.5/);
  assert.match(f.a, /^loudnorm=I=-14/);
  assert.match(f.a, /afade=t=out:st=2.5:d=0.5/);
});

test('hand edits survive a save and reload, and junk is dropped', () => {
  assert.deepEqual(clipEdits({ musicLevel: 0.16, gain: 1.5, normalize: true, holdBeats: 1, fadeIn: 0.2, fadeOut: 9, jumpCut: false }), { musicLevel: 0.16, gain: 1.5, normalize: true, holdBeats: 1, fadeIn: 0.2, fadeOut: 5, jumpCut: false });
  assert.deepEqual(clipEdits({ musicLevel: 1, gain: 1, holdBeats: 0, normalize: 'yes' }), {});
  const p = createProject({});
  const back = sanitizeProject({ ...p, ending: { mode: 'play-out', fade: 2 }, musicCuts: [{ at: 5, length: 0.4 }, { at: -1, length: 1 }, { at: 2, length: 0 }] });
  assert.deepEqual(back.ending, { mode: 'play-out', fade: 2 });
  assert.deepEqual(back.musicCuts, [{ at: 5, length: 0.4 }]);
  assert.equal(sanitizeProject({ ...p, ending: { mode: 'boom' } }).ending, undefined);
});

test('the word a hook ends on is read from the prompt', () => {
  assert.equal(readIntent('the hook is the gojo toji fight ... till gojo goes "exactly" then a slow buildup').untilWord, 'exactly');
  assert.equal(untilWord('until he says exactly and then the fights'), 'exactly');
  assert.equal(untilWord("cut it at 'I gave up'"), 'I gave up');
  assert.equal(untilWord('till the music goes quiet'), undefined);
  assert.equal(readIntent('let the last clip play out and fade with the music').playOut, true);
  assert.equal(readIntent('just let that clip finish out').playOut, true);
  assert.equal(readIntent('30 second deadpool edit').playOut, false);
});

test("a hook ends just after its word, never into the next line", () => {
  // "Exactly" 14.16-15.15 (after refining), "I gave up" from 15.22.
  const words = [
    { t0: 11.1, t1: 13.3, text: 'Reverse' },
    { t0: 14.16, t1: 15.15, text: 'Exactly.' },
    { t0: 15.22, t1: 15.4, text: 'I' },
    { t0: 15.4, t1: 15.6, text: 'gave' },
    { t0: 15.6, t1: 15.8, text: 'up' },
  ];
  const c = { in: 6, out: 14.6, durationSec: 30 };
  assert.equal(hookEnd(words, c, 'exactly'), 15.19);
  assert.equal(hookEnd(words, c), 15.19, 'the cut was mid-word');
  assert.equal(hookEnd(words, c, 'I gave up'), 15.84);
  assert.equal(hookEnd(words, { ...c, out: 14.0 }), undefined, 'already in a pause');
});

test("word ends move to where the sound dies (whisper ends words early)", () => {
  const rate = 16000;
  const s = new Int16Array(rate * 2);
  // A "word" of tone from 0.5 to 1.3 s, whisper says it ends at 1.0 s.
  for (let i = Math.round(0.5 * rate); i < Math.round(1.3 * rate); i++) s[i] = Math.round(8000 * Math.sin(i / 3));
  const [w] = refineWordEnds([{ t0: 0.5, t1: 1.0, text: 'exactly' }, { t0: 1.6, t1: 1.9, text: 'next' }], s, rate);
  assert.ok(Math.abs(w.t1 - 1.3) < 0.04, `end ${w.t1}`);
  // A WAV round trip.
  const data = Buffer.from(s.buffer);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  const back = wavSamples(Buffer.concat([head, data]));
  assert.equal(back.rate, rate);
  assert.equal(back.samples.length, s.length);
  assert.equal(back.samples[Math.round(0.6 * rate)], s[Math.round(0.6 * rate)]);
});

test('kills while you are dead (your death row, or spectating) are not yours', () => {
  assert.deepEqual(dropWhileDead([2.63, 5], [0, 0.25, 0.5, 2.75, 3, 3.25]), [5]);
  assert.deepEqual(dropWhileDead([2.4], undefined), [2.4]);
  assert.deepEqual(dropWhileDead([2.4], []), [2.4]);
});

test('the "DEFEATED BY" card is recognised from its title strip', () => {
  // A blank strip is not the card.
  const blank = new Uint8Array(64 * 12 * 3);
  assert.ok(deathScore(blank) < DEATH_MIN);
  // The card's yellow title, one pixel off to the right, on dark scenery.
  const card = new Uint8Array(64 * 12 * 3).fill(30);
  DEATH_TEMPLATE.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch !== '#' || x + 1 >= 64) return;
    card.set([235, 200, 60], (y * 64 + x + 1) * 3);
  }));
  assert.ok(deathScore(card) > 0.9);
  // Yellow-ish scenery everywhere (a sunset) isn't the card either.
  const sunset = new Uint8Array(64 * 12 * 3);
  for (let i = 0; i < sunset.length; i += 3) sunset.set([230, 190, 70], i);
  assert.ok(deathScore(sunset) < DEATH_MIN);
});
