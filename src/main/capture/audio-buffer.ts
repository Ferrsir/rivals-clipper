// Rolling buffer of PCM audio with wall-clock timestamps, one per track (game, mic).
// The audio helper sends chunks stamped with the epoch time of their first sample, so a clip's audio
// can be cut to exactly the same wall-clock window as its video. Gaps are filled with silence.
// Pure logic with no I/O (unit-tested).

export interface AudioFormat {
  sampleRate: number;
  channels: number;
}

interface PcmChunk {
  epochMs: number;
  frames: number;
  /** Interleaved signed 16-bit little-endian samples. */
  data: Buffer;
}

/** A pin never holds more than this beyond the normal window, so a pin that is never released can't eat RAM. */
const PIN_LIMIT_MS = 10 * 60_000;

export class PcmRing {
  private chunks: PcmChunk[] = [];
  private lastEpoch = 0;
  private pins = new Map<number, number>();
  private nextPin = 1;

  constructor(
    public readonly format: AudioFormat,
    private maxMs: number,
  ) {}

  setMaxMs(ms: number): void {
    this.maxMs = ms;
  }

  /**
   * Keep everything from `fromEpoch` on, even once it is older than the window, until the returned
   * function is called. Used while a clip is being recorded, since a clip can be longer than the window.
   */
  pin(fromEpoch: number): () => void {
    const id = this.nextPin++;
    this.pins.set(id, fromEpoch);
    return () => {
      this.pins.delete(id);
    };
  }

  get bytesPerFrame(): number {
    return this.format.channels * 2;
  }

  /** Epoch ms just after the newest sample held, or 0 when empty. */
  get endEpoch(): number {
    const last = this.chunks[this.chunks.length - 1];
    return last ? last.epochMs + (last.frames * 1000) / this.format.sampleRate : 0;
  }

  get lastChunkAt(): number {
    return this.lastEpoch;
  }

  push(epochMs: number, data: Buffer): void {
    const frames = Math.floor(data.length / this.bytesPerFrame);
    if (!frames) return;
    this.chunks.push({ epochMs, frames, data: Buffer.from(data.subarray(0, frames * this.bytesPerFrame)) });
    this.lastEpoch = epochMs;
    let cutoff = this.endEpoch - this.maxMs;
    for (const from of this.pins.values()) cutoff = Math.min(cutoff, from);
    cutoff = Math.max(cutoff, this.endEpoch - this.maxMs - PIN_LIMIT_MS);
    while (this.chunks.length > 1) {
      const c = this.chunks[0];
      if (c.epochMs + (c.frames * 1000) / this.format.sampleRate < cutoff) this.chunks.shift();
      else break;
    }
  }

  /** PCM for [fromMs, toMs) of wall-clock time. Parts the buffer doesn't cover are silent. */
  extract(fromMs: number, toMs: number): Buffer {
    const rate = this.format.sampleRate;
    const bpf = this.bytesPerFrame;
    const total = Math.max(0, Math.round(((toMs - fromMs) * rate) / 1000));
    const out = Buffer.alloc(total * bpf);
    for (const c of this.chunks) {
      const startFrame = Math.round(((c.epochMs - fromMs) * rate) / 1000);
      const endFrame = startFrame + c.frames;
      if (endFrame <= 0 || startFrame >= total) continue;
      const srcFrom = Math.max(0, -startFrame);
      const dstFrom = Math.max(0, startFrame);
      const n = Math.min(c.frames - srcFrom, total - dstFrom);
      if (n > 0) c.data.copy(out, dstFrom * bpf, srcFrom * bpf, (srcFrom + n) * bpf);
    }
    return out;
  }

  clear(): void {
    this.chunks = [];
    this.lastEpoch = 0;
  }
}

/** A 44-byte WAV header for 16-bit PCM. */
export function wavHeader(dataBytes: number, format: AudioFormat): Buffer {
  const h = Buffer.alloc(44);
  const byteRate = format.sampleRate * format.channels * 2;
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(format.channels, 22);
  h.writeUInt32LE(format.sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(format.channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

// ---------- audio helper wire format ----------
// Each chunk: 24-byte header, then frames * channels * 2 bytes of s16le PCM.
//   0  u32  magic 'RCA1'
//   4  u8   track (0 = game, 1 = mic)
//   5  u8   channels
//   6  u16  reserved
//   8  u32  sample rate
//  12  u32  frames
//  16  f64  epoch ms of the first frame

export const CHUNK_MAGIC = 0x31414352; // 'RCA1' little-endian
export const CHUNK_HEADER = 24;

export interface AudioChunk {
  track: number;
  channels: number;
  sampleRate: number;
  epochMs: number;
  pcm: Buffer;
}

/** Incremental parser for the helper's stdout. */
export class AudioChunkParser {
  private rest: Buffer = Buffer.alloc(0);
  resyncs = 0;

  push(data: Buffer, onChunk: (c: AudioChunk) => void): void {
    let buf = this.rest.length ? Buffer.concat([this.rest, data]) : data;
    let off = 0;
    while (buf.length - off >= CHUNK_HEADER) {
      if (buf.readUInt32LE(off) !== CHUNK_MAGIC) {
        const next = buf.indexOf('RCA1', off + 1, 'ascii');
        this.resyncs++;
        if (next < 0) {
          off = Math.max(off, buf.length - 3);
          break;
        }
        off = next;
        continue;
      }
      const channels = buf[off + 5];
      const frames = buf.readUInt32LE(off + 12);
      const len = frames * channels * 2;
      if (channels < 1 || channels > 8 || len > 16 * 1024 * 1024) {
        off += 4;
        this.resyncs++;
        continue;
      }
      if (buf.length - off < CHUNK_HEADER + len) break;
      onChunk({
        track: buf[off + 4],
        channels,
        sampleRate: buf.readUInt32LE(off + 8),
        epochMs: buf.readDoubleLE(off + 16),
        pcm: buf.subarray(off + CHUNK_HEADER, off + CHUNK_HEADER + len),
      });
      off += CHUNK_HEADER + len;
    }
    this.rest = off < buf.length ? Buffer.from(buf.subarray(off)) : Buffer.alloc(0);
    buf = Buffer.alloc(0);
  }
}

/** Encodes one chunk in the helper's format (used by tests and the fake helper). */
export function encodeChunk(c: AudioChunk): Buffer {
  const h = Buffer.alloc(CHUNK_HEADER);
  h.writeUInt32LE(CHUNK_MAGIC, 0);
  h[4] = c.track;
  h[5] = c.channels;
  h.writeUInt32LE(c.sampleRate, 8);
  h.writeUInt32LE(Math.floor(c.pcm.length / (c.channels * 2)), 12);
  h.writeDoubleLE(c.epochMs, 16);
  return Buffer.concat([h, c.pcm]);
}
