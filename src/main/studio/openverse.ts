// Royalty-free music and pictures from Openverse (openverse.org), WordPress's search over
// Creative Commons and public-domain media (Jamendo, Freesound, ccMixter, Wikimedia, Flickr...).
// Only licences that allow commercial use and editing are requested: CC0, public domain, CC BY, CC BY-SA.
// No API key needed for light use.

import fs from 'node:fs';
import path from 'node:path';
import type { FreeMedia } from '../../shared/studio';

export const OPENVERSE = 'https://api.openverse.org/v1';
const UA = 'RivalsClipper/0.1 (+https://github.com/Ferrsir/rivals-clipper)';
const OK_LICENSES = new Set(['cc0', 'pdm', 'by', 'by-sa']);

type Fetch = typeof fetch;

export function licenceLabel(license: string, version?: string): string {
  const l = license.toLowerCase();
  if (l === 'cc0') return 'CC0';
  if (l === 'pdm') return 'Public domain';
  return `CC ${l.toUpperCase()}${version ? ' ' + version : ''}`;
}

export function creditFor(m: Pick<FreeMedia, 'title' | 'creator' | 'license' | 'licenseVersion' | 'provider'>): string {
  if (m.license === 'cc0' || m.license === 'pdm') return '';
  const who = m.creator ? ` by ${m.creator}` : '';
  const via = m.provider ? ` via ${m.provider}` : '';
  return `"${m.title}"${who} (${licenceLabel(m.license, m.licenseVersion)})${via}`;
}

function clean(s: unknown, max = 160): string | undefined {
  if (typeof s !== 'string') return undefined;
  const t = s.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : undefined;
}

export function parseResults(kind: FreeMedia['kind'], json: unknown): FreeMedia[] {
  const rows: any[] = Array.isArray((json as any)?.results) ? (json as any).results : [];
  const out: FreeMedia[] = [];
  for (const r of rows) {
    const license = String(r?.license ?? '').toLowerCase();
    const url = typeof r?.url === 'string' && /^https:\/\//i.test(r.url) ? r.url : undefined;
    if (!url || !OK_LICENSES.has(license) || r?.mature) continue;
    const m: FreeMedia = {
      id: String(r.id ?? url).slice(0, 80),
      kind,
      title: clean(r.title) ?? 'Untitled',
      creator: clean(r.creator, 100),
      license,
      licenseVersion: clean(r.license_version, 10),
      licenseUrl: clean(r.license_url, 300),
      landingUrl: clean(r.foreign_landing_url, 400),
      url,
      thumbnail: typeof r.thumbnail === 'string' && /^https:\/\//i.test(r.thumbnail) ? r.thumbnail : undefined,
      provider: clean(r.source ?? r.provider, 40),
      durationSec: Number.isFinite(r.duration) ? Math.round(r.duration / 100) / 10 : undefined,
      width: Number.isFinite(r.width) ? r.width : undefined,
      height: Number.isFinite(r.height) ? r.height : undefined,
      credit: '',
      needsCredit: !(license === 'cc0' || license === 'pdm'),
    };
    m.credit = creditFor(m);
    out.push(m);
  }
  return out;
}

export async function search(kind: FreeMedia['kind'], q: string, opts: { pageSize?: number; minSeconds?: number } = {}, fetchFn: Fetch = fetch): Promise<FreeMedia[]> {
  const query = q.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!query) return [];
  const params = new URLSearchParams({ q: query, license: [...OK_LICENSES].join(','), page_size: String(Math.min(40, opts.pageSize ?? 20)), mature: 'false' });
  if (kind === 'audio') params.set('category', 'music');
  const res = await fetchFn(`${OPENVERSE}/${kind === 'audio' ? 'audio' : 'images'}/?${params}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (res.status === 429) throw new Error('Openverse is rate-limiting searches. Try again in a minute.');
  if (!res.ok) throw new Error(`Openverse search failed (${res.status}).`);
  let items = parseResults(kind, await res.json());
  if (kind === 'audio' && opts.minSeconds) items = items.filter((m) => !m.durationSec || m.durationSec >= opts.minSeconds!);
  return items;
}

const EXT: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/flac': '.flac',
  'audio/mp4': '.m4a',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

function safeBase(s: string): string {
  return s.replace(/[^a-z0-9 _-]+/gi, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'download';
}

/** Read a response body, stopping as soon as it passes `max` bytes (chunked responses too). */
export async function readCapped(res: Response, max: number): Promise<Buffer> {
  if (Number(res.headers.get('content-length')) > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error('The file is too big.');
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const parts: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error('The file is too big.');
    }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts, total);
}

/** Download a search result into `dir`. Checks the type and caps the size. */
export async function download(m: FreeMedia, dir: string, fetchFn: Fetch = fetch): Promise<string> {
  if (!/^https:\/\//i.test(m.url)) throw new Error('Only https downloads are allowed.');
  const res = await fetchFn(m.url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (${res.status}).`);
  const type = String(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const want = m.kind === 'audio' ? 'audio/' : 'image/';
  const urlExt = path.extname(new URL(m.url).pathname).toLowerCase();
  if (!type.startsWith(want) && !(type === 'application/octet-stream' && urlExt)) throw new Error(`That link isn't ${m.kind === 'audio' ? 'an audio file' : 'a picture'} (${type || 'unknown type'}).`);
  const max = m.kind === 'audio' ? 60 * 1024 * 1024 : 20 * 1024 * 1024;
  const buf = await readCapped(res, max);
  if (buf.length < 512) throw new Error('The download was empty.');
  const ext = EXT[type] ?? (urlExt && urlExt.length <= 5 ? urlExt : m.kind === 'audio' ? '.mp3' : '.jpg');
  fs.mkdirSync(dir, { recursive: true });
  let dest = path.join(dir, `${safeBase(m.title)}${ext}`);
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, `${safeBase(m.title)}-${n}${ext}`);
  fs.writeFileSync(dest, buf);
  return dest;
}
