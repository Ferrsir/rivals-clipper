import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClipSidecar } from '../src/shared/types';
import type { MusicTrack } from '../src/shared/studio';
import { quickIdeas, sanitizeIdeas, ideasPrompt } from '../src/main/studio/ideas';
import { STYLES } from '../src/main/studio/styles';
import { creditFor, parseResults, readCapped, search } from '../src/main/studio/openverse';
import { FORMATS } from '../src/main/studio/formats';
import * as youtube from '../src/main/studio/publish/youtube';
import * as tiktok from '../src/main/studio/publish/tiktok';
import * as instagram from '../src/main/studio/publish/instagram';
import { challengeHex, listen, waitForCode } from '../src/main/studio/publish/oauth';
import { Vault } from '../src/main/studio/publish/vault';
import { PublishService } from '../src/main/studio/publish';

function clip(id: string, hero: string, kills: number, score: number, tags: string[] = []): ClipSidecar {
  const start = 1_700_000_000_000;
  return {
    version: 1,
    id,
    videoFile: `/clips/${id}.mp4`,
    createdAt: start,
    startTimeEpoch: start,
    durationMs: 18000,
    trigger: 'auto',
    hero,
    match: { map: 'Tokyo 2099' },
    events: Array.from({ length: kills }, (_, k) => ({ type: 'kill' as const, at: start + 10000 + k * 800 })),
    ultUsedBeforeKills: tags.includes('ult'),
    video: { width: 1920, height: 1080, fps: 60 },
    audioTracks: [{ index: 0, label: 'game' }],
    useMic: false,
    score,
    tags,
    scoreBreakdown: {},
  };
}

const LIB = [clip('a', 'Hela', 2, 30), clip('b', 'Hela', 3, 60, ['triple']), clip('c', 'Hela', 5, 140, ['team-wipe', 'penta', 'ult']), clip('d', 'Magik', 1, 10), clip('e', 'Magik', 4, 90, ['quad', 'ult', 'clutch'])];
const TRACK: MusicTrack = { id: 't1', file: '/m/t1.mp3', title: 'Bass', addedAt: 0, license: 'royalty-free', tags: [], analysis: { version: 1, durationSec: 120, bpm: 140, beats: [], downbeats: [], beatEnergy: [], drops: [30], energy: 0.8, confidence: 0.9, peaks: [] } };

function mockFetch(handler: (url: string, init: RequestInit | undefined) => { status?: number; json?: unknown; headers?: Record<string, string | undefined>; body?: string }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = handler(String(url), init);
    return new Response(r.body ?? (r.json !== undefined ? JSON.stringify(r.json) : ''), { status: r.status ?? 200, headers: Object.fromEntries(Object.entries(r.headers ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string> });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function tmpFile(bytes: number): string {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'up-')), 'reel_tiktok.mp4');
  fs.writeFileSync(f, Buffer.alloc(bytes, 7));
  return f;
}

test('quick ideas only use library clips, build up to the best one and match songs by tempo', () => {
  const ideas = quickIdeas(LIB, [TRACK], FORMATS.tiktok);
  assert.ok(ideas.length >= 3);
  const ids = new Set(LIB.map((c) => c.id));
  for (const i of ideas) {
    assert.ok(i.clipIds.length > 0);
    assert.ok(i.clipIds.every((id) => ids.has(id)));
  }
  const spotlight = ideas.find((i) => i.title.includes('Hela'))!;
  assert.deepEqual(spotlight.clipIds, ['a', 'b', 'c']);
  assert.equal(spotlight.music.trackId, 't1');
  assert.ok(ideas.some((i) => i.title === 'Team wipe montage'));
  assert.ok(ideas.some((i) => i.title === 'Ult value'));
});

test('quick ideas use real edit styles, reference-style hooks and end text', () => {
  const ideas = quickIdeas(LIB, [TRACK], FORMATS.tiktok);
  const styleIds = new Set(STYLES.map((s) => s.id));
  for (const i of ideas) assert.ok(styleIds.has(i.styleId), `${i.title} uses unknown style ${i.styleId}`);
  const duel = ideas.find((i) => i.title === 'Hela or Magik?')!;
  assert.ok(duel, 'duel idea');
  assert.equal(duel.hook, "Who's stronger?\nHela?\nOr Magik?");
  assert.equal(duel.endText, 'Comment who wins');
  assert.ok(duel.clipIds.includes('c') && duel.clipIds.includes('e'));
  assert.match(ideas.find((i) => i.title === 'Hela spotlight')!.hook, /^POV: you main Hela$/);
});

test('AI hooks keep up to 4 short lines', () => {
  const raw = { ideas: [{ title: 'Duel', hook: "  Who's stronger?\n\nHim?\nOr you?\nMe\nToo many", endText: ' Comment who wins ', clipIds: ['a'] }] };
  const [idea] = sanitizeIdeas(raw, LIB, [TRACK], FORMATS.tiktok);
  assert.equal(idea.hook, "Who's stronger?\nHim?\nOr you?\nMe");
  assert.equal(idea.endText, 'Comment who wins');
});

test('AI ideas are cleaned: unknown clips, songs and styles are dropped', () => {
  const raw = { ideas: [{ title: 'Good', concept: 'x', hook: 'Rate this', captions: ['one', 2, 'three'], styleId: 'nope', clipIds: ['c', 'zzz', 'c', 'a'], music: { trackId: 'missing', mood: 'dark', bpm: [130, 999], search: 'dark trap' } }, { title: 'No clips', clipIds: ['zzz'] }, { clipIds: ['a'] }] };
  const out = sanitizeIdeas(raw, LIB, [TRACK], FORMATS.tiktok);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].clipIds, ['c', 'a']);
  assert.equal(out[0].styleId, 'montage');
  assert.equal(out[0].music.trackId, undefined);
  assert.deepEqual(out[0].music.bpm, [130, 220]);
  assert.deepEqual(out[0].captions, ['one', 'three']);
  assert.match(ideasPrompt({ clips: LIB, tracks: [TRACK], format: FORMATS.tiktok, request: 'Hela carries', count: 5 }), /Hela carries/);
});

test('openverse results keep only licences that allow commercial use, with credits', () => {
  const items = parseResults('audio', {
    results: [
      { id: '1', title: 'Night Drive', creator: 'Ana', license: 'by', license_version: '4.0', url: 'https://cdn.example/1.mp3', source: 'jamendo', duration: 185000 },
      { id: '2', title: 'NC song', license: 'by-nc', url: 'https://cdn.example/2.mp3' },
      { id: '3', title: 'Free', license: 'cc0', url: 'https://cdn.example/3.mp3' },
      { id: '4', title: 'Insecure', license: 'by', url: 'http://cdn.example/4.mp3' },
    ],
  });
  assert.deepEqual(items.map((i) => i.id), ['1', '3']);
  assert.equal(items[0].credit, '"Night Drive" by Ana (CC BY 4.0) via jamendo');
  assert.equal(items[0].durationSec, 185);
  assert.equal(items[1].needsCredit, false);
  assert.equal(creditFor({ title: 'x', license: 'pdm' }), '');
});

test('openverse search asks for commercial licences and music only', async () => {
  const m = mockFetch(() => ({ json: { results: [] } }));
  await search('audio', 'phonk  drop', {}, m.fn);
  const u = new URL(m.calls[0].url);
  assert.equal(u.pathname, '/v1/audio/');
  assert.equal(u.searchParams.get('q'), 'phonk drop');
  assert.equal(u.searchParams.get('license'), 'cc0,pdm,by,by-sa');
  assert.equal(u.searchParams.get('category'), 'music');
});

test('downloads stop as soon as they pass the size limit, even without a length header', async () => {
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++;
      c.enqueue(new Uint8Array(1024));
    },
  });
  await assert.rejects(readCapped(new Response(endless), 10 * 1024), /too big/);
  assert.ok(pulled < 20, `read ${pulled} chunks`);
  await assert.rejects(readCapped(new Response('x'.repeat(100), { headers: { 'content-length': '999999' } }), 1000), /too big/);
  assert.equal((await readCapped(new Response('hello'), 1000)).toString(), 'hello');
});

test('youtube resumable upload sends metadata, then the file in pieces', async () => {
  const size = youtube.YT_CHUNK + 1000;
  const file = tmpFile(size);
  let puts = 0;
  const m = mockFetch((url, init) => {
    if (init?.method === 'POST') return { headers: { location: 'https://upload.example/session' } };
    puts++;
    return puts === 1 ? { status: 308, headers: { range: `bytes=0-${youtube.YT_CHUNK - 1}` } } : { json: { id: 'vid123' } };
  });
  const pcts: number[] = [];
  const r = await youtube.upload('tok', file, { title: 'Hela diff', description: 'gg', tags: ['#MarvelRivals', 'Hela'], privacy: 'public', shorts: true }, (p) => pcts.push(p), m.fn);
  assert.equal(r.url, 'https://youtube.com/shorts/vid123');
  const meta = JSON.parse(String(m.calls[0].init!.body));
  assert.equal(meta.snippet.categoryId, '20');
  assert.match(meta.snippet.description, /#Shorts/);
  assert.deepEqual(meta.snippet.tags, ['MarvelRivals', 'Hela']);
  assert.equal((m.calls[2].init!.headers as Record<string, string>)['Content-Range'], `bytes ${youtube.YT_CHUNK}-${size - 1}/${size}`);
  assert.equal(pcts.at(-1), 1);
});

test('tiktok chunking follows the API rules', () => {
  assert.deepEqual(tiktok.chunking(3_000_000), { chunkSize: 3_000_000, count: 1 });
  assert.deepEqual(tiktok.chunking(25 * 1024 * 1024), { chunkSize: tiktok.TT_CHUNK, count: 2 });
  assert.equal(challengeHex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('tiktok inbox upload: init, chunks with ranges, then waits for the inbox', async () => {
  const size = 25 * 1024 * 1024;
  const file = tmpFile(size);
  const m = mockFetch((url) => {
    if (url.endsWith('/inbox/video/init/')) return { json: { data: { publish_id: 'p1', upload_url: 'https://up.tiktok.example/x' }, error: { code: 'ok' } } };
    if (url.endsWith('/status/fetch/')) return { json: { data: { status: 'SEND_TO_USER_INBOX' }, error: { code: 'ok' } } };
    return { status: 201 };
  });
  const r = await tiktok.upload({ tiktokMode: 'inbox' }, 'tok', file, { title: 'x', privacy: 'public' }, () => undefined, m.fn);
  assert.match(r.message, /inbox/);
  const init = JSON.parse(String(m.calls[0].init!.body));
  assert.deepEqual(init.source_info, { source: 'FILE_UPLOAD', video_size: size, chunk_size: tiktok.TT_CHUNK, total_chunk_count: 2 });
  const ranges = m.calls.filter((c) => c.init?.method === 'PUT').map((c) => (c.init!.headers as Record<string, string>)['Content-Range']);
  assert.deepEqual(ranges, [`bytes 0-${tiktok.TT_CHUNK - 1}/${size}`, `bytes ${tiktok.TT_CHUNK}-${size - 1}/${size}`]);
});

test('instagram: token from the login redirect, then container, upload, publish', async () => {
  assert.equal(instagram.tokenFromRedirect(`${instagram.LOGIN_DONE}#access_token=abc&expires_in=3600`), 'abc');
  assert.equal(instagram.tokenFromRedirect('https://example.com/'), undefined);
  assert.throws(() => instagram.tokenFromRedirect(`${instagram.LOGIN_DONE}?error=access_denied&error_description=Permissions+error`), /Permissions error/);
  const file = tmpFile(4096);
  const m = mockFetch((url, init) => {
    if (url.endsWith('/ig1/media') && init?.method === 'POST') return { json: { id: 'c1' } };
    if (url.includes('rupload.facebook.com')) return { json: { success: true } };
    if (url.includes('/c1?fields=status_code')) return { json: { status_code: 'FINISHED' } };
    if (url.endsWith('/media_publish')) return { json: { id: 'm1' } };
    if (url.includes('/m1?fields=permalink')) return { json: { permalink: 'https://instagram.com/reel/xyz' } };
    return { status: 404, json: { error: { message: 'unexpected ' + url } } };
  });
  const r = await instagram.upload({ igUserId: 'ig1', tokens: { access: 'tok', expiresAt: Date.now() + 1e9 } }, file, 'caption #mr', () => undefined, m.fn, async () => undefined);
  assert.equal(r.url, 'https://instagram.com/reel/xyz');
  const up = m.calls.find((c) => c.url.includes('rupload'))!;
  assert.equal((up.init!.headers as Record<string, string>).file_size, '4096');
  assert.match(String(m.calls[0].init!.body), /media_type=REELS/);
  assert.match(String(m.calls[0].init!.body), /upload_type=resumable/);
});

test('oauth loopback catches the code and checks state', async () => {
  const lb = await listen('/callback/', 5000);
  assert.match(lb.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback\/$/);
  const waiting = waitForCode(lb, 'st1');
  const res = await fetch(`${lb.redirectUri}?code=abc&state=st1`);
  assert.equal(res.status, 200);
  assert.equal(await waiting, 'abc');
});

test('accounts vault encrypts at rest and keeps keys when disconnecting', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-')), 'a.bin');
  const crypto = { available: () => true, encrypt: (s: string) => Buffer.from(s).reverse(), decrypt: (b: Buffer) => Buffer.from(b).reverse().toString() };
  const v = new Vault(file, crypto);
  const svc = new PublishService({ vault: v, openBrowser: () => undefined, loginWindow: async () => '' });
  svc.configure('youtube', { clientId: ' id-1 ', clientSecret: 'zq-secret-9' });
  v.set('youtube', { tokens: { access: 'a', refresh: 'r', expiresAt: Date.now() + 1e6 }, account: 'My channel' });
  assert.ok(!fs.readFileSync(file).toString().includes('zq-secret-9'));
  const again = new Vault(file, crypto);
  assert.equal(again.get('youtube').clientId, 'id-1');
  const st = new PublishService({ vault: again, openBrowser: () => undefined, loginWindow: async () => '' }).status().find((s) => s.platform === 'youtube')!;
  assert.equal(st.connected, true);
  assert.equal(st.account, 'My channel');
  svc.disconnect('youtube');
  assert.equal(v.get('youtube').tokens, undefined);
  assert.equal(v.get('youtube').clientSecret, 'zq-secret-9');
});


test('long reel prompts reach the AI with their final requirements intact', () => {
  const request = 'Build my reel. '.repeat(700) + 'FINAL REQUIREMENT: keep the triple intact';
  const prompt = ideasPrompt({clips:LIB,tracks:[TRACK],format:FORMATS.tiktok,request,count:1});
  assert.ok(prompt.includes(request));
});
