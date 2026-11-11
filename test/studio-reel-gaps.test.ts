// The gaps found hand-building the Deadpool x JJK pond reel (notes/studio-gaps-jjk-pond-reel.md):
// a white feed row is a kill only with your name on the left, bot games, multi-kills split across clips,
// "only doubles/triples/quads", a song-synced cutaway mid-song split into shots, and one kill per beat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MusicAnalysis, ReelClip } from '../src/shared/studio';
import { classifyRow, isBotRow, judgeHits, learnNames, namesFromSetting, rowAtOnset, sameName, splitRow } from '../src/main/studio/feed-names';
import { joinStreaks, keepStreaksTogether, streakKills } from '../src/main/studio/streaks';
import { checkClip, readClipRules, sanitizeRules } from '../src/main/studio/clip-rules';
import { orderClips, plan } from '../src/main/studio/planner';
import { getStyle, sanitizeStyle } from '../src/main/studio/styles';
import { readIntent, styleFromPrompt } from '../src/main/studio/intent';
import { faceTargets, parseShowinfo, shotCropX, shotSpans, songBreak, splitIntoShots, targetFor } from '../src/main/studio/shots';
import { sanitizeProject, createProject } from '../src/main/studio/projects';

const ME = ['Ferrsir', 'yaomingdiesel'];
// What text recognition read off Ferris's real rows (2026-11-11), portrait junk included.
const words = (...w: string[]) => ({ left: '', right: '', words: w });

test('a white row is your kill only when your name comes first', () => {
  assert.equal(classifyRow(words('fo', 'vaomingdiesel', 'Lowkeymont08'), ME), 'kill');
  assert.equal(classifyRow(words('yaomingdiesel', 'Shayvedlce'), ME), 'kill');
  // 22-55-15: "T1GRE510 > yaomingdiesel" is his death on a white plate.
  assert.equal(classifyRow(words('Oy', 'T1GRES10', 'yaomingdiesel'), ME), 'death');
  assert.equal(classifyRow(words('SAE', 'Shayvedlce'), ME), 'other');
  assert.equal(classifyRow(words(), ME), 'unknown');
  assert.equal(classifyRow(words('yaomingdiesel', 'x'), []), 'unknown');
});

test('names match through OCR slips but not other players', () => {
  assert.ok(sameName('vaominadiesel', 'yaomingdiesel'));
  assert.ok(sameName('omingdiesel', 'yaomingdiesel'));
  assert.ok(sameName('Ferrslr', 'Ferrsir'));
  assert.ok(!sameName('Tired02', 'Ferrsir'));
  assert.ok(!sameName('Phasma242', 'yaomingdiesel'));
  assert.deepEqual(namesFromSetting(' Ferrsir, yaomingdiesel '), ME);
});

test('bot games are spotted by their "-Normal" names', () => {
  assert.ok(isBotRow({ left: 'fot yaomingdiesel', right: 'IRON MAN-Normal' }));
  assert.ok(isBotRow({ left: 'yaomingdiesel', right: 'DEADPOOL Normal' }));
  assert.ok(isBotRow({ left: 'yaomingdiesel', right: 'DEADPOOL-Narmal' }));
  assert.ok(!isBotRow({ left: 'yaomingdiesel', right: 'NormalGuy' }));
  assert.ok(!isBotRow({ left: 'yaomingdiesel', right: 'Phasma242' }));
});

test('judging onsets keeps kills, turns death rows into deaths and drops rows that are not yours', () => {
  const reads = [
    { at: 2.125, names: words('fo', 'yaomingdiesel', 'Tired02') },
    { at: 4.875, names: words('T1GRE510', 'yaomingdiesel') },
    { at: 6.6, names: words('SAE', 'Shayvedlce') },
  ];
  const r = judgeHits([2.125, 4.875, 6.6, 8.0], reads, ME);
  assert.deepEqual(r.hits, [2.125, 8.0]); // 8.0 had no read: kept
  assert.deepEqual(r.deaths, [4.875]);
  assert.equal(r.notMine, 1);
  assert.equal(r.bots, false);
  assert.ok(judgeHits([1], [{ at: 1, names: { left: 'yaomingdiesel', right: 'THOR-Normal' } }], ME).bots);
});

test('the row for an onset is the one entering the top slot', () => {
  const rows = [{ slot: 1, from: 2.25 }, { slot: 0, from: 2.25 }, { slot: 0, from: 6 }];
  assert.equal(rowAtOnset(rows, 2.125), rows[1]);
  assert.equal(rowAtOnset(rows, 4), undefined);
});

test('your names are learned from the rows when the setting is empty', () => {
  const rows = ['a', 'b', 'c', 'd'].flatMap((clip, i) => [
    { clip, names: { left: 'fo yaomingdiesel', right: ['Phasma242', 'Tired02', 'Naolin', 'Demarquees'][i] } },
    { clip, names: { left: ['T1GRE510', 'MedLee', 'Bruffle', 'KINGpinrocks'][i], right: 'vaomingdiesel' } },
  ]);
  const learned = learnNames(rows);
  assert.equal(learned.length, 1);
  assert.ok(sameName(learned[0], 'yaomingdiesel'));
  assert.deepEqual(learnNames(rows.slice(0, 2)), []);
});

test('the OCR line splits into the two names at the widest gap', () => {
  const r = splitRow({ text: '', words: [{ text: 'T1GRE510', x0: 10, x1: 90, conf: 80 }, { text: 'yaomingdiesel', x0: 200, x1: 330, conf: 80 }] }, 340);
  assert.equal(r.left, 'T1GRE510');
  assert.equal(r.right, 'yaomingdiesel');
});

function clip(uid: string, hits: number[], score = 10, dur = 8): ReelClip {
  return { uid, clipId: uid, videoFile: `/c/${uid}.mp4`, kills: hits.length, score, tags: [], durationSec: dur, width: 2584, height: 1080, fps: 60, hasMic: false, hits, in: 0, out: dur, useMic: false, cropX: 0.5, cropY: 0.5, cropZoom: 1 };
}

test('a multi-kill split over two clips is joined back up and counts as a streak', () => {
  // 13:41 triple: 13-41-02 holds kills at 1.5 and 5.5 s, 13-41-05 (3 s later) the third at 1.5 s.
  const a = clip('13-41-02', [1.5, 5.5], 30, 6.5);
  const b = clip('13-41-05', [1.5], 10, 8);
  const lone = clip('13-50-00', [2], 10);
  const out = joinStreaks([{ clip: a, start: 1000 }, { clip: b, start: 1006 }, { clip: lone, start: 1540 }]);
  assert.equal(out.length, 3);
  const [x, y, z] = out;
  assert.deepEqual(x.streak, { id: '13-41-02', kills: 3 });
  assert.deepEqual(y.streak, { id: '13-41-02', kills: 3 });
  assert.equal(z.streak, undefined);
  // The second clip picks up where the first stops, without replaying footage.
  assert.ok(1006 + y.in >= 1000 + x.out - 1e-6, 'no footage twice');
  assert.ok(y.in < 1.5 - 0.5, 'build-up before the third kill');
  assert.equal(streakKills(x), 3);
  assert.ok(checkClip({ heroes: [], notHeroes: [], minKills: 2 }, x).ok);
  assert.ok(!checkClip({ heroes: [], notHeroes: [], minKills: 2 }, z).ok);
});

test('a clip whose kill already plays in the clip before it is dropped from the streak', () => {
  // 22-55-32 and 22-55-36 overlap: both show the kill at real time 1002.9.
  const a = clip('a', [2.9, 6.4], 30, 8);
  const b = clip('b', [2.4 - 4.6 + 4.6, 6.0], 20, 8); // b starts 4.6 s later: its 2.4 is a's 7.0
  const out = joinStreaks([{ clip: a, start: 1000 }, { clip: b, start: 1004.6 }]);
  assert.ok(out.every((c) => c.streak?.kills === out.flatMap((x) => x.hits).length));
  assert.equal(new Set(out.flatMap((c, i) => c.hits.map((h) => (i === 0 ? 1000 : 1004.6) + h)).map((t) => t.toFixed(1))).size, out.flatMap((c) => c.hits).length);
});

test('streak clips stay together when the reel is ordered', () => {
  const a = { ...clip('a', [2], 5), streak: { id: 's', kills: 2 } };
  const b = { ...clip('b', [2], 50), streak: { id: 's', kills: 2 } };
  const c = clip('c', [2], 20);
  assert.deepEqual(orderClips([a, c, b], 'build-up').map((x) => x.uid), ['c', 'a', 'b']);
  assert.deepEqual(keepStreaksTogether([a, c, b]).map((x) => x.uid), ['a', 'b', 'c']);
});

test('"only doubles/triples/quads" means 2 or more, not 4', () => {
  assert.equal(readClipRules('only doubles/triples/quads, deadpool').minKills, 2);
  assert.equal(readClipRules('triples or better').minKills, 3);
  assert.equal(readClipRules('only quads').minKills, 4);
  assert.equal(readClipRules('multi kills only').minKills, 2);
  assert.equal(readClipRules('deadpool clips').minKills, undefined);
});

test('bot games stay out unless the prompt lets them in', () => {
  assert.equal(readClipRules('deadpool clips').bots, undefined);
  assert.equal(readClipRules('include bot games too').bots, true);
  assert.equal(readClipRules('vs ai is fine').bots, true);
  assert.equal(sanitizeRules({ heroes: [], notHeroes: [], bots: true })?.bots, true);
});

function song(bpm: number, seconds: number, quiet?: [number, number]): MusicAnalysis {
  const p = 60 / bpm;
  const beats: number[] = [];
  for (let t = 0.1; t < seconds; t += p) beats.push(Math.round(t * 1000) / 1000);
  return { version: 1, durationSec: seconds, bpm, beats, downbeats: beats.filter((_, i) => i % 4 === 0), beatEnergy: beats.map((b) => (quiet && b >= quiet[0] && b < quiet[1] ? 0.1 : 0.8)), drops: [], energy: 0.8, confidence: 0.9, peaks: [] };
}

test('the song break is the longest quiet run', () => {
  const an = song(96, 30, [9.8, 17]);
  const b = songBreak(an)!;
  assert.ok(b[0] >= 9.7 && b[0] <= 10.5, `starts ${b[0]}`);
  assert.ok(b[1] >= 16.9 && b[1] <= 17.6, `ends ${b[1]}`);
  assert.equal(songBreak(song(96, 30)), undefined);
});

test('a song-synced clip plays at its own song time, with gameplay before and after', () => {
  const an = song(96, 30, [9.8, 17]);
  const style = { ...getStyle('montage'), slowmo: { ...getStyle('montage').slowmo, on: false } };
  const g1 = clip('g1', [3], 10, 8);
  const g2 = clip('g2', [3], 10, 8);
  const anime: ReelClip = { ...clip('anime', [], 0, 29), external: true, songSync: true, in: 9.8, out: 14.98, muteGame: true };
  const g3 = clip('g3', [3], 10, 8);
  const tl = plan({ clips: [g1, g2, anime, g3], style, fps: 60, analysis: an, musicStart: 0 });
  const seg = tl.segments.filter((s) => s.clipUid === 'anime');
  assert.ok(seg.length);
  // Output time = song time - start: source 9.8 plays at 9.8 s (or the clip is entered later to stay in sync).
  const first = seg[0];
  assert.ok(Math.abs(first.src[0] - first.out[0] - 9.8 + 9.8 - 0) < 1 / 30 || Math.abs(first.out[0] - first.src[0]) < 1 / 30, `src ${first.src[0]} at ${first.out[0]}`);
  assert.ok(seg.every((s) => Math.abs(s.speed - 1) < 0.01));
  // Gameplay resumes after the cutaway.
  assert.ok(tl.segments.some((s) => s.clipUid === 'g3' && s.out[0] >= seg[seg.length - 1].out[1] - 1e-6));
  // With the song start left to the planner, it picks one that lines the clip up without skipping into it.
  const auto = plan({ clips: [g1, g2, anime, g3], style, fps: 60, analysis: an, musicStart: 'auto' });
  const s2 = auto.segments.find((s) => s.clipUid === 'anime')!;
  assert.ok(Math.abs(s2.out[0] + auto.musicStart - s2.src[0]) < 1 / 30, `in sync: out ${s2.out[0]} + start ${auto.musicStart} vs src ${s2.src[0]}`);
});

test('one kill per beat: cuts come just before the beat and kills land on it', () => {
  const { style, changes } = styleFromPrompt('only doubles, one kill per beat', getStyle('montage'));
  assert.equal(style.cutLead, 0.25);
  assert.ok(changes.some((c) => c.includes('one kill per beat')));
  assert.equal(sanitizeStyle(style, getStyle('montage')).cutLead, 0.25);
  assert.equal(sanitizeStyle(style, getStyle('montage')).leadIn[0], 0.2);
  const an = song(96, 40);
  const clips = ['a', 'b', 'c', 'd', 'e'].map((u) => clip(u, [3], 10, 8));
  const tl = plan({ clips, style, fps: 60, analysis: an, musicStart: 0 });
  const beat = 60 / 96;
  for (const k of tl.kills.slice(1)) assert.ok(an.beats.some((b) => Math.abs(b - k) < 1.5 / 60), `kill ${k} on a beat`);
  for (const c of tl.cuts) {
    const next = an.beats.find((b) => b > c)!;
    assert.ok(next - c > 0.1 && next - c < 0.45 * beat + 1 / 60, `cut ${c} lands just before beat ${next}`);
  }
});

test('the prompt asking for the clip mid-song is read', () => {
  assert.ok(readIntent('at the pond shot the game clips stop and the jjk clip plays, then the gameplay comes back').cutaway);
  assert.ok(readIntent('put the anime in the middle').cutaway);
  assert.ok(!readIntent('a 30 second deadpool reel to wild side').cutaway);
});

test('a clip is split into shots at its scene cuts, pictures copied without their tracks', () => {
  assert.deepEqual(parseShowinfo('[Parsed_showinfo_1 @ 0x] n:0 pts:1 pts_time:1.53 pos:1\n n:1 pts_time:3.867 '), [1.53, 3.867]);
  assert.deepEqual(shotSpans(9.8, 16.9, [11.33, 11.5, 13.667, 16.8]), [[9.8, 11.33], [11.33, 13.667], [13.667, 16.9]]);
  const c: ReelClip = { ...clip('jjk', [], 0, 29), external: true, songSync: true, in: 9.8, out: 16.9 };
  const ov = [{ id: 'm', image: '/i/Lord_Icon_Magik.webp', clipUid: 'jjk', from: 9.8, to: 16.9, anchor: 'face' as const, x: 0.3, y: 0.4, size: 0.1, shape: 'circle' as const, track: [{ t: 10, x: 0.3, y: 0.4, size: 0.1 }] }];
  let n = 0;
  const r = splitIntoShots(c, [11.33, 13.667], ov, () => `id${n++}`);
  assert.equal(r.clips.length, 3);
  assert.equal(r.clips[0].uid, 'jjk');
  assert.ok(r.clips.every((x) => x.songSync && x.shotOf === 'jjk'));
  assert.equal(r.overlays.length, 3);
  assert.ok(r.overlays.every((o) => o.track === undefined));
  assert.deepEqual(r.overlays.map((o) => [o.from, o.to]), [[9.8, 11.33], [11.33, 13.667], [13.667, 16.9]]);
  assert.equal(shotCropX([{ ...ov[0], clipUid: 'x', track: [{ t: 0, x: 0.2, y: 0, size: 0.1 }, { t: 1, x: 0.4, y: 0, size: 0.1 }] }], 'x'), 0.30000000000000004);
});

test('who each picture goes on is read from the prompt', () => {
  const t = faceTargets("magik's icon on maki and deadpool on naoya");
  assert.deepEqual(t, [{ picture: 'magik', who: 'maki' }, { picture: 'deadpool', who: 'naoya' }]);
  assert.equal(targetFor('C:\\Users\\x\\Lord_Icon_Magik.webp', t), 'maki');
  assert.equal(targetFor('download.png', t), undefined);
});

test('the new clip facts survive saving', () => {
  const p = createProject({ name: 't' });
  const raw = { ...p, clips: [{ ...clip('a', [2]), streak: { id: 's', kills: 3 }, bots: true, songSync: true, shotOf: 'z' }] };
  const back = sanitizeProject(JSON.parse(JSON.stringify(raw)));
  assert.deepEqual(back.clips[0].streak, { id: 's', kills: 3 });
  assert.equal(back.clips[0].bots, true);
  assert.equal(back.clips[0].songSync, true);
  assert.equal(back.clips[0].shotOf, 'z');
});

test('an enemy who kills you again and again is not learned as your name', () => {
  const rows = [
    ...['a', 'b', 'c', 'd', 'e', 'f'].map((clip, i) => ({ clip, names: { left: 'yaomingdiesel', right: ['Phasma242', 'Tired02', 'Naolin', 'Demarquees', 'MedLee', 'Bruffle'][i] } })),
    ...['a', 'b', 'c', 'd'].map((clip) => ({ clip, names: { left: 'T1GRE510', right: 'yaomingdiesel' } })),
  ];
  assert.deepEqual(learnNames(rows), ['yaomingdiesel']);
  // A second account shows on rows without the first.
  const two = [...rows, ...['g', 'h', 'i'].map((clip) => ({ clip, names: { left: 'Ferrsir', right: 'Zyronik' } }))];
  assert.deepEqual(learnNames(two), ['yaomingdiesel', 'Ferrsir']);
});

test('a clip without kills does not split a streak around it', () => {
  const a = clip('a', [2], 10, 8);
  const empty = clip('b', [], 0, 8);
  const c = clip('c', [3], 10, 8);
  const out = joinStreaks([{ clip: a, start: 1000 }, { clip: empty, start: 1002 }, { clip: c, start: 1005 }]);
  assert.deepEqual(out.map((x) => x.uid), ['a', 'c', 'b']); // the streak plays together
  assert.equal(out.find((x) => x.uid === 'a')!.streak?.kills, 2);
  assert.equal(out.find((x) => x.uid === 'c')!.streak?.kills, 2);
});

test('a passing mention of a triple is not a kill rule', () => {
  assert.equal(readClipRules('just make a deadpool reel and end on the triple').minKills, undefined);
  assert.equal(readClipRules('only doubles triples and quads').minKills, 2);
  assert.equal(readClipRules('doubles or better').minKills, 2);
  assert.equal(readClipRules('triples only').minKills, 3);
});

test('a cutaway far past the gameplay is not reached with a long freeze', () => {
  const an = song(96, 90, [60, 66]);
  const style = { ...getStyle('montage'), slowmo: { ...getStyle('montage').slowmo, on: false } };
  const anime: ReelClip = { ...clip('anime', [], 0, 90), external: true, songSync: true, in: 60, out: 66, muteGame: true };
  const tl = plan({ clips: [clip('g1', [3], 10, 8), clip('g2', [3], 10, 8), anime, clip('g3', [3], 10, 8)], style, fps: 60, analysis: an, musicStart: 'auto' });
  const holds = tl.segments.filter((s) => s.kind === 'hold').reduce((sum, s) => sum + s.out[1] - s.out[0], 0);
  assert.ok(holds < 1.5, `held ${holds} s`);
  assert.ok(tl.musicStart > 30, `song starts at ${tl.musicStart}`);
});
