// "make them have subtitles and find a way to use ai voices for them talking": what's said becomes
// TikTok-style subtitles with a speaker, and each speaker's lines are voiced over the ducked original.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ReelClip } from '../src/shared/studio';
import { captionChunks, groupLines, linesToSubtitles, parseWhisperJson } from '../src/main/studio/speech';
import { autoCast, placeVoices, voiceMixArgs, type Synth } from '../src/main/studio/voices';
import { findFile, PIPER_VOICES } from '../src/main/studio/tools';
import { createProject, sanitizeProject } from '../src/main/studio/projects';
import { findFont, planFor, renderProject, spokenLines, subtitleTimes } from '../src/main/studio/pipeline';

const whisperOut = {
  result: { language: 'ja' },
  transcription: [
    { offsets: { from: 500, to: 800 }, text: ' Throughout' },
    { offsets: { from: 800, to: 1200 }, text: ' heaven' },
    { offsets: { from: 1200, to: 1400 }, text: ' and' },
    { offsets: { from: 1400, to: 1900 }, text: ' earth,' },
    { offsets: { from: 1900, to: 2000 }, text: ' I' },
    { offsets: { from: 2000, to: 2300 }, text: ' alone' },
    { offsets: { from: 2300, to: 2500 }, text: ' am' },
    { offsets: { from: 2500, to: 2700 }, text: ' the' },
    { offsets: { from: 2700, to: 3200 }, text: ' honored' },
    { offsets: { from: 3200, to: 3600 }, text: ' one.' },
    { offsets: { from: 3700, to: 4200 }, text: ' [MUSIC]' },
    { offsets: { from: 5000, to: 5400 }, text: ' Not' },
    { offsets: { from: 5400, to: 5800 }, text: ' bad.' },
  ],
};

test('whisper words become spoken lines, split at sentence ends and pauses, without [MUSIC] tags', () => {
  const p = parseWhisperJson(whisperOut);
  assert.equal(p.language, 'ja');
  assert.equal(p.words.length, 12);
  const lines = groupLines(p.words);
  assert.deepEqual(lines.map((l) => l.text), ['Throughout heaven and earth, I alone am the honored one.', 'Not bad.']);
  assert.deepEqual([lines[0].from, lines[0].to, lines[1].from], [0.5, 3.6, 5]);
});

test('a long line is shown a few words at a time across its duration', () => {
  const c = captionChunks('Throughout heaven and earth, I alone am the honored one.', 10, 13);
  assert.ok(c.length >= 3 && c.every((x) => x.text.split(' ').length <= 3), JSON.stringify(c));
  assert.equal(c[0].start, 10);
  assert.equal(c[c.length - 1].end, 13);
  for (let i = 1; i < c.length; i++) assert.ok(Math.abs(c[i].start - c[i - 1].end) < 0.002);
  assert.equal(captionChunks('Not bad.', 1, 2).length, 1);
});

test('each character gets a different voice, and your own cast choices are kept', () => {
  const cast = autoCast(['Gojo', 'Toji'], [{ speaker: 'gojo', voice: 'piper:en_US-amy-medium' }]);
  assert.equal(cast[0].voice, 'piper:en_US-amy-medium');
  assert.notEqual(cast[1].voice, cast[0].voice);
  assert.ok(PIPER_VOICES.some((v) => `piper:${v.id}` === cast[1].voice));
  const v = sanitizeProject({ ...createProject(), voices: { on: true, cast: [{ speaker: 'Gojo', voice: 'piper:en_US-ryan-high', pitch: 2 }, { speaker: 'X', voice: 'rm -rf' }], duck: 5 } }).voices!;
  assert.deepEqual(v.cast.map((r) => r.speaker), ['Gojo']);
  assert.equal(v.duck, 1);
});

test('voice lines never talk over each other and only speed up a little to fit', () => {
  const placed = placeVoices(
    [
      { text: 'a', speaker: 'A', start: 1, end: 2, file: 'a.wav', seconds: 2.4 },
      { text: 'b', speaker: 'B', start: 2.5, end: 3.5, file: 'b.wav', seconds: 1 },
      { text: 'c', speaker: 'A', start: 9.9, end: 11, file: 'c.wav', seconds: 3 },
    ],
    10,
  );
  assert.equal(placed.length, 2, 'a line starting at the very end is dropped');
  assert.ok(placed[0].tempo > 1 && placed[0].tempo <= 1.35);
  assert.ok(placed[1].at >= placed[0].at + placed[0].seconds, 'b waits for a to finish');
  const args = voiceMixArgs('in.mp4', placed, { duck: 0.25, volume: 1.1 }, 'out.mp4', true);
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /volume=0\.25:enable='between/);
  assert.match(graph, /adelay=1000\|1000/);
  assert.match(graph, /amix=inputs=3/);
  assert.ok(args.includes('copy'));
});

test('subtitles on excerpts map into the reel; spoken lines keep who says them', () => {
  const clip = (uid: string, a: number, b: number): ReelClip => ({ uid, clipId: 'asset:x', videoFile: '/v/fight.mp4', external: true, kills: 0, score: 0, tags: [], durationSec: 60, width: 1920, height: 1080, fps: 30, hasMic: false, hits: [], in: a, out: b, useMic: false, cropX: 0.5, cropY: 0.5, cropZoom: 1 });
  const p = createProject({ format: 'tiktok', styleId: 'raw' });
  p.clips = [clip('e1', 0, 6), clip('e2', 20, 26)];
  p.subtitles = linesToSubtitles([{ from: 1, to: 4, text: 'Throughout heaven and earth, I alone am the honored one.', speaker: 'Gojo' }, { from: 21, to: 22, text: 'Not bad.', speaker: 'Toji' }, { from: 40, to: 41, text: 'unused' }], p.clips, '/v/fight.mp4');
  assert.equal(p.subtitles.length, 2);
  const tl = planFor(p, null, 30);
  const spoken = spokenLines(p, tl);
  assert.deepEqual(spoken.map((s) => s.speaker), ['Gojo', 'Toji']);
  assert.ok(spoken[1].start > spoken[0].end);
  assert.ok(subtitleTimes(p, tl).length >= 4, 'the long line is chunked');
});

test('the tools are found inside the folder their zip unpacked to', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'));
  fs.mkdirSync(path.join(d, 'Release'));
  fs.writeFileSync(path.join(d, 'Release', 'whisper-cli.exe'), '');
  assert.equal(findFile(d, ['whisper-cli.exe']), path.join(d, 'Release', 'whisper-cli.exe'));
});

const FF = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    return undefined;
  }
})();

test('a reel with voices renders: the lines are heard over the ducked game sound', { skip: FF ? false : 'ffmpeg not installed', timeout: 240_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiced-'));
  const src = path.join(dir, 'fight.mp4');
  execFileSync(FF!, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=200:sample_rate=48000:duration=8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  const p = createProject({ format: 'tiktok', styleId: 'raw' });
  p.clips = [{ uid: 'e1', clipId: 'asset:x', videoFile: src, external: true, kills: 0, score: 0, tags: [], durationSec: 8, width: 640, height: 360, fps: 30, hasMic: false, hits: [], in: 0, out: 8, useMic: false, cropX: 0.5, cropY: 0.5, cropZoom: 1 }];
  p.subtitles = [{ clipUid: 'e1', from: 1, to: 3, text: 'Stand proud, you are strong.', speaker: 'Gojo' }, { clipUid: 'e1', from: 4.5, to: 6, text: 'Not bad.', speaker: 'Toji' }];
  p.voices = { on: true, cast: [], duck: 0.1, volume: 1 };
  const spoken: string[] = [];
  // A stand-in voice: a 1 kHz tone as long as the line would take to say.
  const synth: Synth = {
    async speak(text, role, out) {
      spoken.push(`${role.voice}:${text}`);
      execFileSync(FF!, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=1000:sample_rate=44100:duration=${(text.length * 0.06).toFixed(2)}`, out]);
    },
  };
  const files = await renderProject({ ffmpeg: FF!, project: p, analysis: null, req: { preview: true, formats: ['tiktok'], noMusicCopy: false, gpu: false }, studioDir: path.join(dir, 'studio'), reelsDir: path.join(dir, 'reels'), fontFile: findFont(), encoder: { name: 'libx264' }, onProgress() {}, synth });
  assert.equal(spoken.length, 2);
  assert.notEqual(spoken[0].split(':')[1], spoken[1].split(':')[1], 'two voices');
  // At 1.5 s the voice (1 kHz) is loud and the game tone (200 Hz) ducked; at 7.5 s only the game tone plays.
  const level = (at: number, f: string) => {
    const r = spawnSync(FF!, ['-hide_banner', '-ss', String(at), '-t', '0.4', '-i', files[0], '-af', `${f},volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' });
    return Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr)![1]);
  };
  assert.ok(level(1.5, 'highpass=f=700') > level(7.5, 'highpass=f=700') + 15, 'voice heard during its line');
  assert.ok(level(1.5, 'lowpass=f=300') < level(7.5, 'lowpass=f=300') - 10, 'game sound ducked under the voice');
});
