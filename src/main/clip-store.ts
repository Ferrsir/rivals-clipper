// Writes and reads the JSON sidecar that sits next to every clip MP4.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ClipSidecar } from '../shared/types';
import { scoreClip } from './scoring';
import { writeFileAtomic } from './settings';

export function sidecarPath(videoFile: string): string {
  return videoFile.replace(/\.[^.]+$/, '') + '.json';
}

export function clipFileName(now: Date, kills: number, hero?: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const safeHero = (hero ?? 'unknown').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  return `${stamp}-${String(now.getMilliseconds()).padStart(3, '0')}-${randomUUID().slice(0, 8)}_${kills}k_${safeHero}`;
}

export function writeSidecar(clip: Omit<ClipSidecar, 'score' | 'tags' | 'scoreBreakdown'>): ClipSidecar {
  const { score, tags, breakdown } = scoreClip(clip);
  const full: ClipSidecar = { ...clip, score, tags, scoreBreakdown: breakdown };
  writeFileAtomic(sidecarPath(clip.videoFile), JSON.stringify(full, null, 2));
  return full;
}

export function updateSidecar(videoFile: string, patch: Partial<ClipSidecar>): ClipSidecar | undefined {
  const p = sidecarPath(videoFile);
  if (!fs.existsSync(p)) return undefined;
  const current = JSON.parse(fs.readFileSync(p, 'utf8')) as ClipSidecar;
  const merged = { ...current, ...patch };
  const { score, tags, breakdown } = scoreClip(merged);
  const full = { ...merged, score, tags, scoreBreakdown: breakdown };
  writeFileAtomic(p, JSON.stringify(full, null, 2));
  return full;
}

/** All clips under the clips folder, newest first. The Library (Phase 2) replaces this with SQLite. */
export function listClips(clipsFolder: string, limit = 200): ClipSidecar[] {
  const out: ClipSidecar[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.json')) {
        try {
          const c = JSON.parse(fs.readFileSync(p, 'utf8')) as ClipSidecar;
          if (c.version === 1 && c.videoFile) out.push(c);
        } catch {
          /* skip broken sidecars */
        }
      }
    }
  };
  walk(clipsFolder);
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

/** True when `file` is an .mp4 inside `clipsFolder` (after resolving `..` and case on Windows). */
export function isClipFile(file: unknown, clipsFolder: string): file is string {
  if (typeof file !== 'string' || !/\.mp4$/i.test(file)) return false;
  const rel = path.relative(path.resolve(clipsFolder), path.resolve(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
