import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AiTagger, buildPrompt, frameArgs, frameTimesMs, parseReply, untagged } from '../src/main/ai-tagger';
import { scoreClip } from '../src/main/scoring';
import { queryClips } from '../src/main/library';
import type { AiClient } from '../src/main/ai-auth';
import type { ClipAiInfo, ClipSidecar } from '../src/shared/types';

const base = (over: Partial<ClipSidecar> = {}): ClipSidecar => ({
  version: 1,
  id: 'x',
  videoFile: '/tmp/none.mp4',
  createdAt: 1,
  startTimeEpoch: 10_000,
  durationMs: 20_000,
  trigger: 'auto',
  hero: 'Magik',
  match: { map: 'Klyntar', gameType: 'Competitive' },
  events: [],
  ultUsedBeforeKills: false,
  video: { width: 1920, height: 1080, fps: 60 },
  audioTracks: [{ index: 0, label: 'game' }],
  useMic: false,
  score: 0,
  tags: [],
  scoreBreakdown: {},
  ...over,
});
const kill = (at: number) => ({ type: 'kill' as const, at });

test('frames are taken just after each kill, at most four, inside the clip', () => {
  assert.deepEqual(frameTimesMs(base({ events: [kill(15_000), kill(17_000)] })), [5150, 7150]);
  const many = frameTimesMs(base({ events: [0, 1, 2, 3, 4, 5].map((i) => kill(11_000 + i * 1000)) }));
  assert.equal(many.length, 4);
  assert.equal(many[0], 1150);
  assert.equal(many[3], 6150);
  assert.deepEqual(frameTimesMs(base({ events: [kill(99_000)] })), [19_900]);
  assert.equal(frameTimesMs(base()).length, 2);
});

test('AI replies are cleaned: tags slugged and capped, summary trimmed, hype clamped', () => {
  const r = parseReply({ tags: ['Flank', 'ULT combo!', 'flank', 3, 'a', 'b', 'c', 'd', 'e'], summary: '  Magik  dives the backline  ', hype: 14.4 });
  assert.deepEqual(r.tags, ['flank', 'ult-combo', 'a', 'b', 'c', 'd']);
  assert.equal(r.summary, 'Magik dives the backline');
  assert.equal(r.hype, 10);
  assert.deepEqual(parseReply('nonsense'), { tags: [], summary: '', hype: 5 });
  assert.equal(parseReply({ hype: -3 }).hype, 1);
});

test('the prompt carries the clip facts and asks for JSON', () => {
  const p = buildPrompt(base({ events: [{ ...kill(12_000), victimHero: 'Luna Snow' }], ultUsedBeforeKills: true, tags: ['fast', 'hero:Magik'] }));
  for (const s of ['Magik', 'Luna Snow', 'Klyntar', 'Competitive', 'ultimate', 'fast', '"hype"']) assert.ok(p.includes(s), s);
  assert.ok(!p.includes('hero:Magik'));
});

test('frame grab seeks before the input and scales down', () => {
  const a = frameArgs('C:\\a b\\c.mp4', 5150, 'f.jpg');
  assert.ok(a.indexOf('-ss') < a.indexOf('-i'));
  assert.equal(a[a.indexOf('-ss') + 1], '5.150');
  assert.equal(a.at(-1), 'f.jpg');
});

test('AI tags join the clip tags, change the score and are searchable', () => {
  const ai: ClipAiInfo = { tags: ['flank'], summary: 'Sneaky backline wipe', hype: 9, provider: 'claude', at: 1 };
  const plain = scoreClip(base({ events: [kill(12_000)] }));
  const tagged = scoreClip(base({ events: [kill(12_000)], ai }));
  assert.ok(tagged.tags.includes('flank'));
  assert.equal(tagged.score - plain.score, 16);
  const failed = scoreClip(base({ events: [kill(12_000)], ai: { ...ai, error: 'timeout' } }));
  assert.equal(failed.score, plain.score);
  const c = base({ ai, tags: tagged.tags });
  assert.equal(queryClips([c], { text: 'sneaky' }).total, 1);
  assert.deepEqual(untagged([c, base({ id: 'y' }), base({ id: 'z', ai: { ...ai, error: 'x' } })]).map((x) => x.id), ['y', 'z']);
});

function fakeFfmpeg(dir: string): string {
  const bin = path.join(dir, 'ffmpeg');
  fs.writeFileSync(bin, '#!/bin/sh\nfor last; do :; done\necho jpg > "$last"\n');
  fs.chmodSync(bin, 0o755);
  return bin;
}

test('tagger reads frames, asks the AI and saves the answer; failures are saved too', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagger-'));
  try {
    const video = path.join(dir, 'clip.mp4');
    fs.writeFileSync(video, 'x');
    let clip = base({ videoFile: video, events: [kill(12_000), kill(13_000)] });
    let seen: string[] = [];
    let fail = false;
    const ai: AiClient = {
      status: async () => ({ signedIn: true, provider: 'claude' }),
      ask: async (o) => {
        seen = o.imagePaths ?? [];
        assert.ok(seen.every((p) => fs.existsSync(p)));
        if (fail) throw new Error('rate limited');
        return { text: '', provider: 'claude', json: { tags: ['dive'], summary: 'Double dive', hype: 7 } };
      },
    };
    const tagger = new AiTagger({
      ai,
      ffmpeg: async () => fakeFfmpeg(dir),
      read: () => clip,
      save: (_f, info) => (clip = { ...clip, ai: info }),
      canRun: () => true,
      enabled: () => true,
    });
    const r = await tagger.tagOne(video);
    assert.equal(seen.length, 2);
    assert.deepEqual(r?.ai?.tags, ['dive']);
    assert.equal(r?.ai?.hype, 7);
    assert.ok(seen.every((p) => !fs.existsSync(p)), 'frames are cleaned up');

    fail = true;
    const f = await tagger.tagOne(video);
    assert.equal(f?.ai?.error, 'rate limited');
    assert.deepEqual(f?.ai?.tags, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tagger waits while a match is on', async () => {
  let asked = 0;
  let canRun = false;
  const tagger = new AiTagger({
    ai: { status: async () => ({ signedIn: true, provider: 'claude' }), ask: async () => (asked++, { text: '', provider: 'claude' }) },
    ffmpeg: async () => undefined,
    read: () => undefined,
    save: () => undefined,
    canRun: () => canRun,
    enabled: () => true,
  });
  tagger.enqueue('a.mp4');
  await (tagger as unknown as { drain(): Promise<void> }).drain();
  assert.equal(tagger.pending, 1);
  canRun = true;
  await (tagger as unknown as { drain(): Promise<void> }).drain();
  assert.equal(tagger.pending, 0);
  assert.equal(asked, 0, 'a clip with no sidecar is skipped without asking');
  tagger.kick(60_000);
  clearTimeout((tagger as unknown as { timer: NodeJS.Timeout }).timer);
});
