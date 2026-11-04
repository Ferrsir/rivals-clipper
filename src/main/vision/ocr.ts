// Text recognition for the screen detector (player names, "N PLAYER KO STREAK!", map, VICTORY/DEFEAT).
// Uses tesseract.js (WebAssembly, runs locally, nothing is uploaded) with the English model bundled
// in the app. Optional: if it can't load, kills are still detected from the KO list and banners.

import fs from 'node:fs';
import path from 'node:path';
import type { Crop } from './image';
import type { OcrResult, OcrWord } from './fusion';

export type OcrMode = 'light-text' | 'dark-text' | 'big-text';

/** Otsu's threshold of a luma crop. */
export function otsu(data: Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (const v of data) hist[v]++;
  const total = data.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * Turns a crop into black text on white, scaled so letters are ~40 px tall (what Tesseract reads best),
 * as a binary PGM image.
 */
export function prepareForOcr(crop: Crop, mode: OcrMode, targetHeight = 64): Buffer {
  const factor = Math.max(1, Math.min(6, Math.round(targetHeight / Math.max(1, crop.h))));
  const w = crop.w * factor;
  const h = crop.h * factor;
  // White HUD text: keep only the brightest pixels; text on a light row: keep the dark ones.
  const t = mode === 'dark-text' ? Math.min(otsu(crop.data), 150) : Math.max(otsu(crop.data), 170);
  const out = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(crop.h - 1, Math.floor(y / factor));
    for (let x = 0; x < w; x++) {
      const v = crop.data[sy * crop.w + Math.min(crop.w - 1, Math.floor(x / factor))];
      const ink = mode === 'dark-text' ? v < t : v >= t;
      out[y * w + x] = ink ? 0 : 255;
    }
  }
  // A white border helps Tesseract find the text line.
  const pad = 12;
  const pw = w + pad * 2;
  const ph = h + pad * 2;
  const padded = Buffer.alloc(pw * ph, 255);
  for (let y = 0; y < h; y++) out.copy(padded, (y + pad) * pw + pad, y * w, (y + 1) * w);
  return Buffer.concat([Buffer.from(`P5\n${pw} ${ph}\n255\n`, 'ascii'), padded]);
}

interface TesseractWorker {
  recognize(image: Buffer, opts?: object, output?: object): Promise<{ data: TesseractData }>;
  setParameters(p: Record<string, string | number>): Promise<unknown>;
  terminate(): Promise<unknown>;
}

interface TesseractWordBox {
  text: string;
  confidence: number;
  bbox: { x0: number; x1: number };
}

interface TesseractData {
  text: string;
  confidence: number;
  blocks?: Array<{ paragraphs: Array<{ lines: Array<{ words: TesseractWordBox[] }> }> }> | null;
}

function unpacked(p: string): string {
  // Worker threads and the WebAssembly loader can't read inside app.asar; electron-builder unpacks these.
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

/** One Tesseract worker, used one request at a time. */
export class ScreenOcr {
  private worker?: TesseractWorker;
  private loading?: Promise<boolean>;
  private queue: Array<() => Promise<void>> = [];
  private busy = false;
  failed?: string;
  reads = 0;
  totalMs = 0;

  async init(): Promise<boolean> {
    if (this.worker) return true;
    this.loading ??= (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const tesseract = require('tesseract.js') as {
          createWorker(lang: string, oem: number, opts: object): Promise<TesseractWorker>;
        };
        const langDir = unpacked(path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int'));
        const workerPath = unpacked(require.resolve('tesseract.js/src/worker-script/node/index.js'));
        if (!fs.existsSync(path.join(langDir, 'eng.traineddata.gz'))) throw new Error('English text model missing');
        const worker = await tesseract.createWorker('eng', 1, { langPath: langDir, cacheMethod: 'none', gzip: true, workerPath });
        await worker.setParameters({ tessedit_pageseg_mode: 7, preserve_interword_spaces: '1' });
        this.worker = worker;
        return true;
      } catch (err) {
        this.failed = (err as Error).message;
        return false;
      }
    })();
    return this.loading;
  }

  /** Reads one crop. Requests wait in line; `maxWaitMs` drops ones that waited too long to matter. */
  read(crop: Crop, mode: OcrMode, maxWaitMs = 4000): Promise<OcrResult | undefined> {
    const queued = Date.now();
    return new Promise((resolve) => {
      this.queue.push(async () => {
        if (!this.worker || Date.now() - queued > maxWaitMs) return resolve(undefined);
        const started = Date.now();
        try {
          const img = prepareForOcr(crop, mode);
          await this.worker.setParameters({ tessedit_pageseg_mode: mode === 'big-text' ? 6 : 7 });
          const r = await this.worker.recognize(img, {}, { text: true, blocks: true });
          resolve(toResult(r.data));
        } catch {
          resolve(undefined);
        } finally {
          this.reads++;
          this.totalMs += Date.now() - started;
        }
      });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length) await this.queue.shift()!();
    this.busy = false;
  }

  async terminate(): Promise<void> {
    const w = this.worker;
    this.worker = undefined;
    this.loading = undefined;
    await w?.terminate().catch(() => undefined);
  }
}

export function toResult(d: TesseractData): OcrResult {
  const words: OcrWord[] = [];
  for (const b of d.blocks ?? [])
    for (const p of b.paragraphs)
      for (const l of p.lines) for (const w of l.words) words.push({ text: w.text, x0: w.bbox.x0, x1: w.bbox.x1, conf: w.confidence });
  return { text: d.text ?? '', words };
}
