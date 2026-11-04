// OAuth for a desktop app: PKCE plus a one-shot listener on 127.0.0.1 that catches the redirect.

import crypto from 'node:crypto';
import http from 'node:http';

export function verifier(): string {
  return crypto.randomBytes(48).toString('base64url').slice(0, 64);
}

export function challengeB64(v: string): string {
  return crypto.createHash('sha256').update(v).digest('base64url');
}

/** TikTok's desktop flow wants the SHA-256 as hex rather than base64url. */
export function challengeHex(v: string): string {
  return crypto.createHash('sha256').update(v).digest('hex');
}

export function state(): string {
  return crypto.randomBytes(16).toString('hex');
}

export interface Loopback {
  redirectUri: string;
  /** Resolves with the query of the first request to the callback path. */
  result: Promise<URLSearchParams>;
  close(): void;
}

const PAGE = (ok: boolean, msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>Rivals Clipper</title><body style="font:16px system-ui;background:#0f1115;color:#e8eaf0;display:grid;place-items:center;height:100vh;margin:0"><div><h2>${ok ? 'Connected' : 'Not connected'}</h2><p>${msg}</p></div></body>`;

export function listen(callbackPath = '/callback/', timeoutMs = 5 * 60_000): Promise<Loopback> {
  return new Promise((resolveServer, rejectServer) => {
    let done: (q: URLSearchParams) => void;
    let fail: (e: Error) => void;
    const result = new Promise<URLSearchParams>((res, rej) => {
      done = res;
      fail = rej;
    });
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== callbackPath) {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE(!err, err ? 'You can close this tab and try again in Rivals Clipper.' : 'You can close this tab and go back to Rivals Clipper.'));
      done(url.searchParams);
      setTimeout(close, 200);
    });
    const timer = setTimeout(() => {
      fail(new Error('Sign-in timed out. Try connecting again.'));
      close();
    }, timeoutMs);
    function close() {
      clearTimeout(timer);
      server.close();
    }
    server.on('error', rejectServer);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolveServer({ redirectUri: `http://127.0.0.1:${port}${callbackPath}`, result, close });
    });
  });
}

/** Wait for the redirect, check `state`, and return the code. */
export async function waitForCode(lb: Loopback, expectedState: string): Promise<string> {
  const q = await lb.result;
  const err = q.get('error');
  if (err) throw new Error(`Sign-in was cancelled or refused (${q.get('error_description') || err}).`);
  if (q.get('state') !== expectedState) throw new Error('Sign-in reply did not match. Try again.');
  const code = q.get('code');
  if (!code) throw new Error('Sign-in reply had no code.');
  return code;
}

export async function postForm(fetchFn: typeof fetch, url: string, form: Record<string, string>): Promise<any> {
  const res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  if (!res.ok || json.error) throw new Error(`Sign-in failed: ${json.error_description || json.error?.message || json.error || res.status}`);
  return json;
}
