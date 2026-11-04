// TikTok uploads through the Content Posting API, with your own TikTok developer app.
// "inbox" (the default) sends the video to your TikTok inbox as a draft: you add the sound,
// caption and cover in the app and post it. "direct" posts straight away, but TikTok keeps
// direct posts private until your app passes their audit.

import fs from 'node:fs';
import type { Account, Tokens } from './vault';
import { challengeHex, listen, postForm, state, verifier, waitForCode } from './oauth';

const AUTH = 'https://www.tiktok.com/v2/auth/authorize/';
const API = 'https://open.tiktokapis.com/v2';
const MIN_CHUNK = 5 * 1024 * 1024;
export const TT_CHUNK = 10 * 1024 * 1024;

type Fetch = typeof fetch;

export const scopesFor = (mode: 'inbox' | 'direct') => (mode === 'direct' ? 'user.info.basic,video.publish' : 'user.info.basic,video.upload');

export function authUrl(clientKey: string, redirectUri: string, challenge: string, st: string, mode: 'inbox' | 'direct'): string {
  const q = new URLSearchParams({ client_key: clientKey, scope: scopesFor(mode), response_type: 'code', redirect_uri: redirectUri, state: st, code_challenge: challenge, code_challenge_method: 'S256' });
  return `${AUTH}?${q}`;
}

function toTokens(j: any): Tokens {
  return {
    access: j.access_token,
    refresh: j.refresh_token,
    expiresAt: Date.now() + (Number(j.expires_in) || 86400) * 1000 - 60_000,
    refreshExpiresAt: j.refresh_expires_in ? Date.now() + Number(j.refresh_expires_in) * 1000 : undefined,
    scope: j.scope,
  };
}

export async function connect(acc: Account, openBrowser: (url: string) => void, fetchFn: Fetch = fetch): Promise<{ tokens: Tokens; account: string }> {
  if (!acc.clientId || !acc.clientSecret) throw new Error('Add your TikTok client key and secret first.');
  const mode = acc.tiktokMode ?? 'inbox';
  const lb = await listen('/callback/');
  try {
    const v = verifier();
    const st = state();
    openBrowser(authUrl(acc.clientId, lb.redirectUri, challengeHex(v), st, mode));
    const code = await waitForCode(lb, st);
    const j = await postForm(fetchFn, `${API}/oauth/token/`, { client_key: acc.clientId, client_secret: acc.clientSecret, code, grant_type: 'authorization_code', redirect_uri: lb.redirectUri, code_verifier: v });
    const tokens = toTokens(j);
    return { tokens, account: await displayName(tokens.access, fetchFn) };
  } finally {
    lb.close();
  }
}

async function displayName(access: string, fetchFn: Fetch): Promise<string> {
  try {
    const r = await fetchFn(`${API}/user/info/?fields=display_name`, { headers: { Authorization: `Bearer ${access}` } });
    const j: any = await r.json();
    return j?.data?.user?.display_name ?? 'TikTok';
  } catch {
    return 'TikTok';
  }
}

export async function fresh(acc: Account, fetchFn: Fetch = fetch): Promise<Tokens> {
  const t = acc.tokens;
  if (!t) throw new Error('Connect TikTok first.');
  if (!t.expiresAt || t.expiresAt > Date.now()) return t;
  if (!t.refresh || !acc.clientId || !acc.clientSecret) throw new Error('TikTok sign-in expired. Connect again.');
  return toTokens(await postForm(fetchFn, `${API}/oauth/token/`, { client_key: acc.clientId, client_secret: acc.clientSecret, grant_type: 'refresh_token', refresh_token: t.refresh }));
}

/** TikTok's chunk rules: one chunk under 5 MB; otherwise equal chunks with the remainder in the last one. */
export function chunking(size: number, chunk = TT_CHUNK): { chunkSize: number; count: number } {
  if (size <= Math.max(MIN_CHUNK, chunk)) return { chunkSize: size, count: 1 };
  return { chunkSize: chunk, count: Math.floor(size / chunk) };
}

async function api(fetchFn: Fetch, access: string, pathname: string, body: unknown): Promise<any> {
  const res = await fetchFn(`${API}${pathname}`, { method: 'POST', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(body) });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || (j?.error?.code && j.error.code !== 'ok')) throw new Error(explain(j?.error?.code, j?.error?.message ?? String(res.status)));
  return j.data ?? {};
}

function explain(code: string | undefined, msg: string): string {
  switch (code) {
    case 'spam_risk_too_many_posts':
      return 'TikTok says you have posted too much today. Try again tomorrow.';
    case 'spam_risk_user_banned_from_posting':
      return 'TikTok is not letting this account post right now.';
    case 'scope_not_authorized':
      return 'Your TikTok app is not approved for this kind of upload yet. Check the Content Posting API product in your developer app.';
    case 'unaudited_client_can_only_post_to_private_accounts':
      return 'Your TikTok app has not passed TikTok\'s audit, so it can only post to private accounts. Use "Send to drafts" instead.';
    case 'access_token_invalid':
      return 'TikTok sign-in expired. Connect again.';
    default:
      return `TikTok: ${msg}`;
  }
}

export interface TtMeta {
  title: string;
  privacy: 'public' | 'unlisted' | 'private';
}

export async function upload(acc: Account, access: string, file: string, meta: TtMeta, onPct: (p: number, msg: string) => void, fetchFn: Fetch = fetch): Promise<{ publishId: string; url?: string; message: string }> {
  const mode = acc.tiktokMode ?? 'inbox';
  const size = fs.statSync(file).size;
  const { chunkSize, count } = chunking(size);
  const source_info = { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: count };
  let data: any;
  if (mode === 'direct') {
    const info = await api(fetchFn, access, '/post/publish/creator_info/query/', {});
    const options: string[] = info.privacy_level_options ?? [];
    const want = meta.privacy === 'public' ? 'PUBLIC_TO_EVERYONE' : 'SELF_ONLY';
    const privacy_level = options.includes(want) ? want : options.includes('SELF_ONLY') ? 'SELF_ONLY' : options[0];
    data = await api(fetchFn, access, '/post/publish/video/init/', { post_info: { title: meta.title.slice(0, 2200), privacy_level, disable_comment: false, disable_duet: false, disable_stitch: false }, source_info });
  } else {
    data = await api(fetchFn, access, '/post/publish/inbox/video/init/', { source_info });
  }
  const uploadUrl: string = data.upload_url;
  const publishId: string = data.publish_id;
  if (!uploadUrl || !publishId) throw new Error('TikTok did not return an upload address.');

  const fd = fs.openSync(file, 'r');
  try {
    for (let i = 0; i < count; i++) {
      const start = i * chunkSize;
      const end = i === count - 1 ? size - 1 : start + chunkSize - 1;
      const len = end - start + 1;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      const res = await fetchFn(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(len), 'Content-Range': `bytes ${start}-${end}/${size}` }, body: buf });
      if (!res.ok && res.status !== 206) throw new Error(`TikTok upload failed at part ${i + 1} of ${count} (${res.status}).`);
      onPct(((i + 1) / count) * 0.9, 'Uploading to TikTok');
    }
  } finally {
    fs.closeSync(fd);
  }

  // Wait for TikTok to take it (up to ~2 minutes).
  for (let k = 0; k < 40; k++) {
    await new Promise((r) => setTimeout(r, k === 0 ? 1500 : 3000));
    const st = await api(fetchFn, access, '/post/publish/status/fetch/', { publish_id: publishId });
    if (st.status === 'FAILED') throw new Error(`TikTok could not process the video (${st.fail_reason ?? 'unknown reason'}).`);
    if (st.status === 'SEND_TO_USER_INBOX') return { publishId, message: 'In your TikTok inbox. Open TikTok to add the sound and post it.' };
    if (st.status === 'PUBLISH_COMPLETE') {
      const postId = st.publicaly_available_post_id?.[0] ?? st.publicly_available_post_id?.[0];
      return { publishId, url: postId ? `https://www.tiktok.com/video/${postId}` : undefined, message: 'Posted to TikTok.' };
    }
    onPct(0.92, 'TikTok is processing the video');
  }
  return { publishId, message: 'Uploaded. TikTok is still processing it, so check the app in a few minutes.' };
}
