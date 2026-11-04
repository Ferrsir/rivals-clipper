// In-memory replay buffer for an MPEG-TS video stream (what ffmpeg writes to stdout in local mode).
// It cuts the stream into GOPs (one keyframe plus the frames after it), keeps the last N seconds,
// and maps video timestamps to wall-clock time so clips line up with the separately captured audio.
// Pure logic with no I/O, so it is unit-tested with real ffmpeg output.

export const TS_PACKET = 188;
const SYNC = 0x47;
const PTS_WRAP = 2 ** 33;
const VIDEO_STREAM_TYPES = new Set([0x01, 0x02, 0x1b, 0x24, 0x10]);

export interface Gop {
  /** PTS of the keyframe, in 90 kHz ticks, unwrapped (keeps growing past the 33-bit wrap). */
  pts: number;
  /** PTS of the last frame that started in this GOP. */
  lastPts: number;
  /** Epoch ms when the keyframe arrived from ffmpeg. */
  arrivedAt: number;
  packets: Buffer[];
  bytes: number;
  frames: number;
}

export interface CaptureResult {
  /** TS bytes: PAT + PMT, then whole GOPs. Ready to write to a .ts file. */
  data: Buffer;
  /** Wall-clock (epoch ms) of the first frame. */
  startEpoch: number;
  /** Wall-clock (epoch ms) just after the last frame. */
  endEpoch: number;
  frames: number;
}

export interface CaptureHandle {
  readonly gops: Gop[];
  active: boolean;
}

export interface TsBufferOptions {
  /** How much video to keep, in ms. */
  maxMs: number;
  /** Frame duration in 90 kHz ticks, used for the end time of the last frame. Default 60 fps. */
  frameTicks?: number;
  /** How long a clock-offset sample stays relevant, in ms. Older samples drop out of the min filter. */
  clockWindowMs?: number;
}

/**
 * Parses MPEG-TS packets, groups them by keyframe and keeps a rolling window.
 * ffmpeg must mark keyframes with the random-access flag, which its mpegts muxer does.
 */
export class TsReplayBuffer {
  private rest: Buffer = Buffer.alloc(0);
  private pmtPid = -1;
  private videoPid = -1;
  private pat?: Buffer;
  private pmt?: Buffer;
  private gops: Gop[] = [];
  private current?: Gop;
  private lastRawPts = -1;
  private wraps = 0;
  /** (arrivedAt - ptsMs) samples for a sliding-window minimum: the true offset plus the smallest delay seen. */
  private offsets: Array<{ at: number; offset: number }> = [];
  private captures = new Set<CaptureHandle>();
  private readonly frameTicks: number;
  private readonly clockWindowMs: number;
  bytesIn = 0;
  packetsDropped = 0;

  constructor(private opts: TsBufferOptions) {
    this.frameTicks = opts.frameTicks ?? 1500;
    this.clockWindowMs = opts.clockWindowMs ?? 30_000;
  }

  setMaxMs(ms: number): void {
    this.opts.maxMs = ms;
  }

  /** Feed bytes from ffmpeg's stdout. `now` is the arrival time (epoch ms). */
  push(chunk: Buffer, now = Date.now()): void {
    this.bytesIn += chunk.length;
    const buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    let off = 0;
    // Packets are copied in runs (one copy per stdout chunk per GOP), not one Buffer per 188-byte packet.
    let runStart = -1;
    const flush = (end: number, gop = this.current) => {
      if (runStart >= 0 && end > runStart && gop) {
        gop.packets.push(Buffer.from(buf.subarray(runStart, end)));
        gop.bytes += end - runStart;
      }
      runStart = -1;
    };
    while (buf.length - off >= TS_PACKET) {
      if (buf[off] !== SYNC) {
        flush(off);
        // Lost sync: find the next position where two packets in a row start with 0x47.
        let next = off + 1;
        while (next < buf.length && !(buf[next] === SYNC && (next + TS_PACKET >= buf.length || buf[next + TS_PACKET] === SYNC))) next++;
        this.packetsDropped++;
        off = next;
        continue;
      }
      // inspect() switches `current` to the new GOP, so the run before it belongs to the previous one.
      const before = this.current;
      const startsGop = this.inspect(buf, off, now);
      if (startsGop) {
        flush(off, before);
        runStart = off;
      } else if (runStart < 0 && this.current) {
        runStart = off;
      }
      off += TS_PACKET;
    }
    flush(off);
    this.rest = off < buf.length ? Buffer.from(buf.subarray(off)) : Buffer.alloc(0);
    this.evict(now);
  }

  /** Wall-clock time (epoch ms) of a PTS, from the clock estimate. */
  wallOf(pts: number): number {
    return pts / 90 + this.clockOffset();
  }

  clockOffset(): number {
    if (!this.offsets.length) return 0;
    let min = Infinity;
    for (const o of this.offsets) if (o.offset < min) min = o.offset;
    return min;
  }

  /** Seconds of video currently held. */
  get durationMs(): number {
    if (!this.gops.length) return 0;
    const first = this.gops[0];
    const last = this.current ?? this.gops[this.gops.length - 1];
    return (last.lastPts + this.frameTicks - first.pts) / 90;
  }

  get bytesHeld(): number {
    return this.gops.reduce((n, g) => n + g.bytes, 0);
  }

  get ready(): boolean {
    return this.gops.length > 0 && !!this.pat && !!this.pmt;
  }

  /**
   * Start a clip that includes `pastMs` of footage before `now`.
   * It begins at the last keyframe at or before that point (up to one GOP earlier), or the oldest one held.
   */
  beginCapture(pastMs: number, now = Date.now()): CaptureHandle {
    const target = now - pastMs;
    let startIdx = 0;
    for (let i = 0; i < this.gops.length; i++) {
      if (this.wallOf(this.gops[i].pts) <= target) startIdx = i;
      else break;
    }
    const handle: CaptureHandle = { gops: this.gops.slice(startIdx), active: true };
    this.captures.add(handle);
    return handle;
  }

  /** Wall-clock time of a capture's first frame, or undefined before any video has arrived. */
  captureStart(handle: CaptureHandle): number | undefined {
    const first = handle.gops[0];
    return first ? this.wallOf(first.pts) : undefined;
  }

  /** Finish a clip. Returns the TS bytes and exact wall-clock bounds. */
  endCapture(handle: CaptureHandle, untilEpoch?: number): CaptureResult | undefined {
    handle.active = false;
    this.captures.delete(handle);
    let gops = handle.gops;
    if (untilEpoch !== undefined) {
      // Drop whole GOPs that start after the requested end (keeps at least one).
      const cut = gops.findIndex((g, i) => i > 0 && this.wallOf(g.pts) > untilEpoch);
      if (cut > 0) gops = gops.slice(0, cut);
    }
    if (!gops.length || !this.pat || !this.pmt) return undefined;
    const parts: Buffer[] = [this.pat, this.pmt];
    let frames = 0;
    for (const g of gops) {
      parts.push(...g.packets);
      frames += g.frames;
    }
    const first = gops[0];
    const last = gops[gops.length - 1];
    return {
      data: Buffer.concat(parts),
      startEpoch: this.wallOf(first.pts),
      endEpoch: this.wallOf(last.lastPts + this.frameTicks),
      frames,
    };
  }

  cancelCapture(handle: CaptureHandle): void {
    handle.active = false;
    this.captures.delete(handle);
  }

  reset(): void {
    this.rest = Buffer.alloc(0);
    this.gops = [];
    this.current = undefined;
    this.offsets = [];
    this.lastRawPts = -1;
    this.wraps = 0;
    for (const c of this.captures) c.active = false;
    this.captures.clear();
  }

  // ---------- internals ----------

  /** Reads one packet's headers. Returns true when it is the first packet of a keyframe (a new GOP starts). */
  private inspect(buf: Buffer, at: number, now: number): boolean {
    const pid = ((buf[at + 1] & 0x1f) << 8) | buf[at + 2];
    const pusi = (buf[at + 1] & 0x40) !== 0;
    const afc = (buf[at + 3] >> 4) & 0x3;
    let payload = 4;
    let rai = false;
    if (afc & 0x2) {
      const afLen = buf[at + 4];
      if (afLen > 0) rai = (buf[at + 5] & 0x40) !== 0;
      payload = 5 + afLen;
    }
    const hasPayload = (afc & 0x1) !== 0 && payload < TS_PACKET;
    if (!hasPayload || !pusi) return false;
    const pkt = buf.subarray(at, at + TS_PACKET);
    if (pid === 0) {
      this.parsePat(pkt, payload);
      this.pat = Buffer.from(pkt);
      return false;
    }
    if (pid === this.pmtPid) {
      this.parsePmt(pkt, payload);
      this.pmt = Buffer.from(pkt);
      return false;
    }
    if (pid !== this.videoPid) return false;
    const pts = this.readPts(pkt, payload);
    if (pts === undefined) return false;
    if (rai) {
      this.startGop(pts, now);
      return true;
    }
    if (this.current) {
      this.current.lastPts = Math.max(this.current.lastPts, pts);
      this.current.frames++;
    }
    return false;
  }

  private startGop(pts: number, now: number): void {
    const gop: Gop = { pts, lastPts: pts, arrivedAt: now, packets: [], bytes: 0, frames: 1 };
    this.current = gop;
    this.gops.push(gop);
    for (const c of this.captures) if (c.active) c.gops.push(gop);
    this.offsets.push({ at: now, offset: now - pts / 90 });
    const cutoff = now - this.clockWindowMs;
    while (this.offsets.length > 2 && this.offsets[0].at < cutoff) this.offsets.shift();
  }

  private evict(now: number): void {
    // Keep GOPs whose end is inside the window. Clips in progress hold their own references.
    while (this.gops.length > 1) {
      const second = this.gops[1];
      if (this.wallOf(second.pts) < now - this.opts.maxMs) this.gops.shift();
      else break;
    }
  }

  private readPts(pkt: Buffer, p: number): number | undefined {
    if (p + 14 > TS_PACKET) return undefined;
    if (pkt[p] !== 0 || pkt[p + 1] !== 0 || pkt[p + 2] !== 1) return undefined;
    const flags = pkt[p + 7];
    if (!(flags & 0x80)) return undefined;
    const b = p + 9;
    const raw =
      ((pkt[b] >> 1) & 0x07) * 2 ** 30 +
      pkt[b + 1] * 2 ** 22 +
      (pkt[b + 2] >> 1) * 2 ** 15 +
      pkt[b + 3] * 2 ** 7 +
      (pkt[b + 4] >> 1);
    if (this.lastRawPts >= 0 && raw < this.lastRawPts - 2 ** 32) this.wraps++;
    this.lastRawPts = raw;
    return raw + this.wraps * PTS_WRAP;
  }

  private parsePat(pkt: Buffer, p: number): void {
    const start = p + 1 + pkt[p]; // pointer field
    if (start + 8 > TS_PACKET || pkt[start] !== 0x00) return;
    const sectionLen = ((pkt[start + 1] & 0x0f) << 8) | pkt[start + 2];
    const end = Math.min(start + 3 + sectionLen - 4, TS_PACKET);
    for (let i = start + 8; i + 4 <= end; i += 4) {
      const program = (pkt[i] << 8) | pkt[i + 1];
      const pmtPid = ((pkt[i + 2] & 0x1f) << 8) | pkt[i + 3];
      if (program !== 0) {
        this.pmtPid = pmtPid;
        return;
      }
    }
  }

  private parsePmt(pkt: Buffer, p: number): void {
    const start = p + 1 + pkt[p];
    if (start + 12 > TS_PACKET || pkt[start] !== 0x02) return;
    const sectionLen = ((pkt[start + 1] & 0x0f) << 8) | pkt[start + 2];
    const end = Math.min(start + 3 + sectionLen - 4, TS_PACKET);
    const infoLen = ((pkt[start + 10] & 0x0f) << 8) | pkt[start + 11];
    for (let i = start + 12 + infoLen; i + 5 <= end; ) {
      const type = pkt[i];
      const pid = ((pkt[i + 1] & 0x1f) << 8) | pkt[i + 2];
      const esLen = ((pkt[i + 3] & 0x0f) << 8) | pkt[i + 4];
      if (VIDEO_STREAM_TYPES.has(type)) {
        this.videoPid = pid;
        return;
      }
      i += 5 + esLen;
    }
  }
}
