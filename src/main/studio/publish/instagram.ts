// Instagram Reels through the Instagram Graph API (Facebook Login for Business), with your own Meta app.
// Needs an Instagram professional account (Creator or Business) linked to a Facebook Page.
// The video is sent straight from this PC (resumable upload), so nothing has to be hosted online.

import fs from 'node:fs';
import type { Account, Tokens } from './vault';

export const GRAPH_VERSION = 'v23.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const RUPLOAD = `https://rupload.facebook.com/ig-api-upload/${GRAPH_VERSION}`;
export const LOGIN_DONE = 'https://www.facebook.com/connect/login_success.html';
const SCOPES = ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement', 'business_management'];

type Fetch = typeof fetch;

export function loginUrl(appId: string): string {
  const q = new URLSearchParams({ client_id: appId, redirect_uri: LOGIN_DONE, response_type: 'token', scope: SCOPES.join(','), display: 'popup' });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${q}`;
}

/** Pull the token out of the login window's final address. */
export function tokenFromRedirect(url: string): string | undefined {
  if (!url.startsWith(LOGIN_DONE)) return undefined;
  const frag = new URLSearchParams(url.split('#')[1] ?? '');
  const err = new URL(url).searchParams.get('error_description') ?? new URL(url).searchParams.get('error');
  if (err) throw new Error(`Facebook sign-in was cancelled or refused (${err}).`);
  return frag.get('access_token') ?? undefined;
}

async function get(fetchFn: Fetch, url: string): Promise<any> {
  const res = await fetchFn(url);
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(`Instagram: ${j?.error?.error_user_msg ?? j?.error?.message ?? res.status}`);
  return j;
}

async function post(fetchFn: Fetch, url: string, form: Record<string, string>): Promise<any> {
  const res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(`Instagram: ${j?.error?.error_user_msg ?? j?.error?.message ?? res.status}`);
  return j;
}

/**
 * Finish sign-in: swap the short-lived token for a ~60 day one and find the Instagram account
 * linked to one of your Facebook Pages.
 */
export async function finishLogin(acc: Account, shortToken: string, fetchFn: Fetch = fetch): Promise<{ tokens: Tokens; account: string; igUserId: string }> {
  if (!acc.clientId || !acc.clientSecret) throw new Error('Add your Meta app ID and secret first.');
  const q = new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: acc.clientId, client_secret: acc.clientSecret, fb_exchange_token: shortToken });
  const long = await get(fetchFn, `${GRAPH}/oauth/access_token?${q}`);
  const access: string = long.access_token;
  const pages = await get(fetchFn, `${GRAPH}/me/accounts?fields=name,instagram_business_account{id,username}&access_token=${encodeURIComponent(access)}`);
  const page = (pages.data ?? []).find((p: any) => p?.instagram_business_account?.id);
  if (!page) throw new Error('No Instagram professional account is linked to your Facebook Pages. In Instagram, switch to a Creator account and link it to a Page, then connect again.');
  const ig = page.instagram_business_account;
  return {
    tokens: { access, expiresAt: Date.now() + (Number(long.expires_in) || 60 * 86400) * 1000 - 3600_000 },
    account: ig.username ? `@${ig.username}` : page.name,
    igUserId: ig.id,
  };
}

export function fresh(acc: Account): Tokens {
  const t = acc.tokens;
  if (!t || !acc.igUserId) throw new Error('Connect Instagram first.');
  if (t.expiresAt && t.expiresAt < Date.now()) throw new Error('Instagram sign-in expired (they last about 60 days). Connect again.');
  return t;
}

export async function upload(acc: Account, file: string, caption: string, onPct: (p: number, msg: string) => void, fetchFn: Fetch = fetch, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<{ id: string; url?: string }> {
  const t = fresh(acc);
  const ig = acc.igUserId!;
  const container = await post(fetchFn, `${GRAPH}/${ig}/media`, { media_type: 'REELS', upload_type: 'resumable', caption: caption.slice(0, 2200), share_to_feed: 'true', access_token: t.access });
  const cid: string = container.id;
  if (!cid) throw new Error('Instagram did not create an upload.');
  const size = fs.statSync(file).size;
  onPct(0.05, 'Uploading to Instagram');
  const res = await fetchFn(`${RUPLOAD}/${cid}`, { method: 'POST', headers: { Authorization: `OAuth ${t.access}`, offset: '0', file_size: String(size) }, body: fs.readFileSync(file) });
  const up: any = await res.json().catch(() => ({}));
  if (!res.ok || up.success === false) throw new Error(`Instagram upload failed: ${up?.debug_info?.message ?? res.status}`);
  onPct(0.7, 'Instagram is processing the video');

  // Instagram asks for about one check a minute; processing usually takes under a minute or two.
  for (let k = 0; k < 10; k++) {
    await sleep(k === 0 ? 10_000 : 30_000);
    const st = await get(fetchFn, `${GRAPH}/${cid}?fields=status_code,status&access_token=${encodeURIComponent(t.access)}`);
    if (st.status_code === 'FINISHED') {
      const pub = await post(fetchFn, `${GRAPH}/${ig}/media_publish`, { creation_id: cid, access_token: t.access });
      let url: string | undefined;
      try {
        url = (await get(fetchFn, `${GRAPH}/${pub.id}?fields=permalink&access_token=${encodeURIComponent(t.access)}`)).permalink;
      } catch {
        /* the post is live either way */
      }
      onPct(1, 'Posted');
      return { id: pub.id, url };
    }
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error(`Instagram could not process the video (${st.status ?? st.status_code}).`);
    onPct(0.7 + k * 0.025, 'Instagram is processing the video');
  }
  throw new Error('Instagram is taking too long to process the video. Check the app; it may still appear.');
}
