// Ferris, 2026-11-05: "heres the clip of gojo vs toji, heres also a picture of deadpools icon put his
// icon on gojo and make them have subtitles ... a reel thats about 20-30 seconds ... to the song aizo".
// Clips can come from any game or show, so the Studio finds their action itself and reads the prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MediaAsset, MusicTrack, ReelIdea } from '../src/shared/studio';
import { audioMoments, excerptClips, expandOwnFootage, mergeMoments, parseSceneTimes, pickExcerpts } from '../src/main/studio/moments';
import { findSong, readIntent, songFromPrompt } from '../src/main/studio/intent';
import { createProject, externalClip, footageName, projectFromIdea, sanitizeProject } from '../src/main/studio/projects';
import { sanitizeIdeas } from '../src/main/studio/ideas';
import { reviseReel } from '../src/main/studio/ai';
import { FORMATS } from '../src/main/studio/formats';
import { plan } from '../src/main/studio/planner';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'any-footage-'));
const touch = (name: string) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, '');
  return f;
};
const PROMPT = 'heres the clip of gojo vs toji, heres also a picture of deadpools icon put his icon on gojo and make them have subtitles and find a way to use ai voices for them talking and have it run into a reel thats about 20-30 seconds of gameplay to the song aizo';

function fight(seconds = 90): MediaAsset {
  const moments = Array.from({ length: Math.floor(seconds / 3) }, (_, i) => ({ t: 1.5 + i * 3, s: 1 + ((i * 7) % 5) }));
  return { id: 'fight1', kind: 'video', file: touch('gojo-vs-toji.mp4'), name: 'gojo-vs-toji.mp4', durationSec: seconds, width: 1920, height: 1080, hasAudio: true, moments };
}
const icon = (): MediaAsset => ({ id: 'icon1', kind: 'image', file: touch('deadpool.png'), name: 'deadpool.png' });

test('the prompt is read for the length, the song, subtitles, voices and the face picture', () => {
  const i = readIntent(PROMPT);
  assert.equal(i.seconds, 30);
  assert.equal(i.song, 'aizo');
  assert.equal(i.subtitles, true);
  assert.equal(i.voices, true);
  assert.equal(i.faceOverlay, true);
  assert.equal(songFromPrompt('cut it to the song "Specialz" and add shake'), 'Specialz');
  assert.equal(songFromPrompt('song: Aizo by King Gnu'), 'Aizo by King Gnu');
  assert.equal(songFromPrompt('make a 30 second reel'), undefined);
  const plain = readIntent('make a 30 second magik montage');
  assert.deepEqual([plain.subtitles, plain.voices, plain.faceOverlay, plain.song], [false, false, false, undefined]);
});

test('a song named in the prompt is found in the music folder however the file is named', () => {
  const t = (id: string, file: string, title: string, artist?: string): MusicTrack => ({ id, file, title, artist, addedAt: 1, license: 'own', tags: [] });
  const tracks = [t('a', 'C:/music/Specialz.mp3', 'SPECIALZ', 'King Gnu'), t('b', 'C:/music/King Gnu - AIZO (Official Audio).mp3', 'King Gnu - AIZO (Official Audio)'), t('c', 'C:/music/phonk.mp3', 'Brazilian Phonk')];
  assert.equal(findSong(tracks, 'aizo')?.id, 'b');
  assert.equal(findSong(tracks, 'Aizo by King Gnu')?.id, 'b');
  assert.equal(findSong(tracks, 'specialz')?.id, 'a');
  assert.equal(findSong(tracks, 'never gonna give you up'), undefined);
});

test('loud hits in any soundtrack become action moments', () => {
  const sr = 11025;
  const s = new Float32Array(sr * 10);
  for (let i = 0; i < s.length; i++) s[i] = 0.02 * Math.sin(i * 0.05);
  for (const at of [2, 5, 8]) for (let i = 0; i < sr * 0.15; i++) s[Math.round(at * sr) + i] = (Math.random() * 2 - 1) * 0.9 * Math.exp(-i / (sr * 0.05));
  const m = audioMoments(s, sr);
  for (const at of [2, 5, 8]) assert.ok(m.some((x) => Math.abs(x.t - at) < 0.12), `found the hit at ${at}s in ${JSON.stringify(m)}`);
  assert.ok(m.length <= 5, `no flood of fake hits: ${m.length}`);
});

test('visual changes from ffmpeg boost the sound hits they line up with', () => {
  const scenes = parseSceneTimes('[Parsed_showinfo_2] n:   0 pts:  30030 pts_time:2.002   duration\n[Parsed_showinfo_2] n:   1 pts:  90090 pts_time:6.006 ');
  assert.deepEqual(scenes, [2.002, 6.006]);
  const merged = mergeMoments([{ t: 2.1, s: 2 }, { t: 4, s: 1.8 }], scenes, 10);
  assert.deepEqual(merged.map((m) => m.t), [2.1, 4, 6.006]);
  assert.equal(merged[0].s, 3);
});

test('a long fight becomes excerpts around its biggest moments, in story order, that fill the reel', () => {
  const a = fight(90);
  const ex = pickExcerpts(a.moments!, 90, 30);
  const total = ex.reduce((s, e) => s + e.out - e.in, 0);
  assert.ok(total >= 28 && total < 40, `about 30 s of source, got ${total}`);
  for (let i = 1; i < ex.length; i++) assert.ok(ex[i].in >= ex[i - 1].out, 'chronological, no overlap');
  for (const e of ex) assert.ok(e.hits.every((h) => h > e.in && h < e.out) && e.hits.length, 'each excerpt holds its moments');
  const strong = a.moments!.filter((m) => m.s === 5).map((m) => m.t);
  assert.ok(strong.every((t) => ex.some((e) => e.hits.includes(t))), 'the strongest hits are all used');
  // A short clip is used whole.
  assert.equal(pickExcerpts([{ t: 2, s: 1 }], 8, 30).length, 1);
});

test('an AI plan can cut one video into several excerpts and put the picture on every one', () => {
  const a = fight();
  const idea: ReelIdea = {
    ...sanitizeIdeas({ ideas: [{ title: 'Gojo vs Toji', game: 'Jujutsu Kaisen', clipIds: ['asset:fight1', 'asset:fight1', 'asset:fight1'], clipEdits: [{ clipId: 'asset:fight1', in: 3, out: 8 }, { clipId: 'asset:fight1', in: 20, out: 25 }, { clipId: 'asset:fight1', in: 60, out: 66 }], overlays: [{ assetId: 'asset:icon1', onClip: 'asset:fight1', from: 0, to: 90, anchor: 'face', x: 0.4, y: 0.3, size: 0.1 }], subtitles: [{ onClip: 'asset:fight1', from: 21, to: 23, text: 'Stand proud.' }] }] }, [], [], FORMATS.tiktok, [a, icon()], PROMPT)[0],
  };
  assert.equal(idea.game, 'Jujutsu Kaisen');
  assert.equal(idea.clipIds.length, 3);
  const p = projectFromIdea(idea, [], []);
  assert.equal(p.game, 'Jujutsu Kaisen');
  assert.equal(footageName(p), 'Jujutsu Kaisen');
  assert.deepEqual(p.clips.map((c) => [c.in, c.out]), [[3, 8], [20, 25], [60, 66]]);
  assert.ok(p.clips.every((c) => c.external && c.hits.length && c.hits.every((h) => h > c.in && h < c.out)));
  assert.equal(new Set(p.clips.map((c) => c.uid)).size, 3);
  assert.equal(p.overlays!.length, 3, 'the picture follows into each excerpt');
  assert.equal(p.subtitles!.length, 3);
  assert.equal(sanitizeProject(p).game, 'Jujutsu Kaisen');
});

test('a whole long video in the plan is split into excerpts, and the moments drive beat-synced cuts', () => {
  const a = fight();
  const p = createProject({ format: 'tiktok' });
  p.assets = [a, icon()];
  p.clips = [externalClip(a)];
  p.overlays = [{ id: 'o1', image: icon().file, clipUid: p.clips[0].uid, from: 0, to: 90, anchor: 'face', x: 0.4, y: 0.3, size: 0.1, shape: 'circle' }];
  assert.equal(footageName(p), 'fan');
  const { project, expanded } = expandOwnFootage(p, 30);
  assert.equal(expanded, 1);
  assert.ok(project.clips.length >= 3, `${project.clips.length} excerpts`);
  assert.equal(project.overlays!.length, project.clips.length);
  assert.equal(new Set(project.overlays!.map((o) => o.id)).size, project.clips.length);
  const step = 60 / 128;
  const beats = Array.from({ length: 300 }, (_, i) => Math.round(i * step * 1000) / 1000);
  const tl = plan({ clips: project.clips, style: project.style, fps: 30, analysis: { version: 1, durationSec: 140, bpm: 128, beats, downbeats: beats.filter((_, i) => i % 4 === 0), beatEnergy: beats.map(() => 0.5), drops: [beats[64]], energy: 0.7, confidence: 0.9, peaks: [] }, targetSeconds: 30 });
  assert.ok(tl.duration >= 18 && tl.duration <= 31, `reel is ${tl.duration} s`);
  assert.ok(tl.kills.length >= project.clips.length, 'moments are placed like kills');
  // Excerpts keep their own moment list.
  assert.deepEqual(excerptClips(p.clips[0], a, 10).map((c) => c.hits.length > 0), excerptClips(p.clips[0], a, 10).map(() => true));
});

test('a revision can trim your own footage freely and add another excerpt of it', async () => {
  const a = fight();
  const p = createProject({ format: 'tiktok' });
  p.assets = [a];
  p.game = 'Jujutsu Kaisen';
  const c = externalClip(a);
  c.in = 10;
  c.out = 16;
  p.clips = [c];
  let prompt = '';
  const ai = { status: async () => ({ signedIn: true, provider: 'claude' }), ask: async (q: any) => { prompt = q.prompt; return { text: '', json: { clips: [{ uid: c.uid, in: 11, out: 14 }, { clipId: 'asset:fight1', in: 40, out: 45 }], summary: 'Tighter, plus the finisher.' } }; } } as any;
  const r = await reviseReel(ai, p, 'tighter and add the finisher', []);
  assert.match(prompt, /Jujutsu Kaisen/);
  assert.doesNotMatch(prompt, /Marvel Rivals gameplay edit/);
  assert.deepEqual(r.project.clips.map((x) => [x.in, x.out]), [[11, 14], [40, 45]]);
});
