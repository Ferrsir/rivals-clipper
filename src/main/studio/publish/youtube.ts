// YouTube uploads (videos and Shorts) through the YouTube Data API v3, with your own Google Cloud
// OAuth client ("Desktop app" type). Resumable upload in 8 MB pieces, so big exports survive hiccups.

import fs from 'node:fs';
import type { Account, Tokens } from './vault';
import { challengeB64, listen, postForm, state, verifier, waitForCode } from './oauth';

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
const CHANNELS = 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true';
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];
export const YT_CHUNK = 8 * 1024 * 1024; // must be a multiple of 256 KB

type Fetch = typeof fetch;

export function authUrl(clientId: string, redirectUri: string, challenge: string, st: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    state: st,
  });
  return `${AUTH}?${q}`;
}

function toTokens(j: any, old?: Tokens): Tokens {
  return { access: j.access_token, refresh: j.refresh_token ?? old?.refresh, expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 60_000, scope: j.scope ?? old?.scope };
}

export async function connect(acc: Account, openBrowser: (url: string) => void, fetchFn: Fetch = fetch): Promise<{ tokens: Tokens; account: string }> {
  if (!acc.clientId || !acc.clientSecret) throw new Error('Add your Google OAuth client ID and secret first.');
  const lb = await listen('/');
  try {
    const v = verifier();
    const st = state();
    openBrowser(authUrl(acc.clientId, lb.redirectUri, challengeB64(v), st));
    const code = await waitForCode(lb, st);
    const j = await postForm(fetchFn, TOKEN, { client_id: acc.clientId, client_secret: acc.clientSecret, code, code_verifier: v, grant_type: 'authorization_code', redirect_uri: lb.redirectUri });
    const tokens = toTokens(j);
    return { tokens, account: await channelName(tokens.access, fetchFn) };
  } finally {
    lb.close();
  }
}

export async function channelName(access: string, fetchFn: Fetch = fetch): Promise<string> {
  try {
    const r = await fetchFn(CHANNELS, { headers: { Authorization: `Bearer ${access}` } });
    const j: any = await r.json();
    return j?.items?.[0]?.snippet?.title ?? 'YouTube';
  } catch {
    return 'YouTube';
  }
}

export async function fresh(acc: Account, fetchFn: Fetch = fetch): Promise<Tokens> {
  const t = acc.tokens;
  if (!t) throw new Error('Connect YouTube first.');
  if (!t.expiresAt || t.expiresAt > Date.now()) return t;
  if (!t.refresh || !acc.clientId || !acc.clientSecret) throw new Error('YouTube sign-in expired. Connect again.');
  const j = await postForm(fetchFn, TOKEN, { client_id: acc.clientId, client_secret: acc.clientSecret, refresh_token: t.refresh, grant_type: 'refresh_token' });
  return toTokens(j, t);
}

export interface YtMeta {
  title: string;
  description: string;
  tags: string[];
  privacy: 'public' | 'unlisted' | 'private';
  shorts?: boolean;
}

export function metadata(m: YtMeta) {
  let title = m.title.replace(/[<>]/g, '').trim() || 'Marvel Rivals';
  let description = m.description.replace(/[<>]/g, '');
  if (m.shorts && !/#shorts/i.test(title + description)) description = `${description}\n\n#Shorts`.trim();
  title = title.slice(0, 100);
  const tags: string[] = [];
  let len = 0;
  for (const t of m.tags.map((x) => x.replace(/^#/, '').replace(/[<>,]/g, '').trim()).filter(Boolean)) {
    if (len + t.length + 1 > 450) break;
    tags.push(t);
    len += t.length + 1;
  }
  return { snippet: { title, description: description.slice(0, 5000), tags, categoryId: '20' }, status: { privacyStatus: m.privacy, selfDeclaredMadeForKids: false } };
}

export async function upload(access: string, file: string, meta: YtMeta, onPct: (p: number) => void, fetchFn: Fetch = fetch, signal?: AbortSignal): Promise<{ id: string; url: string }> {
  const size = fs.statSync(file).size;
  const init = await fetchFn(UPLOAD, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': 'video/mp4' },
    body: JSON.stringify(metadata(meta)),
    signal,
  });
  if (!init.ok) throw new Error(`YouTube refused the upload: ${await errText(init)}`);
  const session = init.headers.get('location');
  if (!session) throw new Error('YouTube did not return an upload address.');
  const fd = fs.openSync(file, 'r');
  try {
    let offset = 0;
    while (offset < size) {
      const len = Math.min(YT_CHUNK, size - offset);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      const res = await fetchFn(session, {
        method: 'PUT',
        headers: { 'Content-Length': String(len), 'Content-Range': `bytes ${offset}-${offset + len - 1}/${size}` },
        body: buf,
        signal,
      });
      if (res.status === 308) {
        const range = res.headers.get('range');
        offset = range ? Number(range.split('-')[1]) + 1 : offset + len;
        onPct(offset / size);
        continue;
      }
      if (res.ok) {
        const j: any = await res.json();
        onPct(1);
        return { id: j.id, url: meta.shorts ? `https://youtube.com/shorts/${j.id}` : `https://youtu.be/${j.id}` };
      }
      throw new Error(`YouTube upload failed: ${await errText(res)}`);
    }
    throw new Error('YouTube upload ended without a video id.');
  } finally {
    fs.closeSync(fd);
  }
}

async function errText(res: Response): Promise<string> {
  try {
    const j: any = await res.json();
    const reason = j?.error?.errors?.[0]?.reason;
    if (reason === 'quotaExceeded') return 'the daily upload quota for your Google project is used up. Try again tomorrow.';
    if (reason === 'uploadLimitExceeded') return 'your channel hit its daily upload limit.';
    return j?.error?.message ?? String(res.status);
  } catch {
    return String(res.status);
  }
}
