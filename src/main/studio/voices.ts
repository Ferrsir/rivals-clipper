// AI voices for the characters: each subtitle line with a speaker is read by that character's voice,
// placed where the line is in the reel, with the original sound ducked underneath. Voices are made
// on your PC with Piper (free, offline), or Windows' built-in voices when Piper can't be set up.
// No paid services and no cloned voices of real actors.

import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AiClient } from '../ai-auth';
import type { VoiceRole, VoiceSettings } from '../../shared/studio';
import { PIPER_VOICES, type SpeechTools, type ToolProgress } from './tools';

export interface SpokenLine {
  text: string;
  speaker: string;
  /** Reel seconds where the line is on screen. */
  start: number;
  end: number;
}

export interface PlacedVoice {
  file: string;
  /** Reel seconds. */
  at: number;
  /** Playback speed applied to fit the slot. */
  tempo: number;
  seconds: number;
}

export interface Synth {
  /** Write `text` spoken by `role` to `out` (a wav file). */
  speak(text: string, role: VoiceRole, out: string, signal?: AbortSignal): Promise<void>;
}

/** A voice per character: the cast you set, then distinct voices for the rest (deeper for the second male). */
export function autoCast(speakers: string[], existing: VoiceRole[] = []): VoiceRole[] {
  const cast: VoiceRole[] = [];
  const used = new Set(existing.map((r) => r.voice));
  const males = PIPER_VOICES.filter((v) => v.sex === 'm').map((v) => `piper:${v.id}`);
  let next = 0;
  for (const s of speakers) {
    const have = existing.find((r) => r.speaker.toLowerCase() === s.toLowerCase());
    if (have) {
      cast.push(have);
      continue;
    }
    let voice = males[next % males.length];
    for (let k = 0; k < males.length && used.has(voice); k++) voice = males[++next % males.length];
    next++;
    used.add(voice);
    cast.push({ speaker: s, voice, pitch: /narrator/i.test(s) ? -1 : 0 });
  }
  return cast;
}

/** Let the AI pick fitting voices for the characters (e.g. a cocky young voice for Gojo, deep and rough for Toji). */
export async function aiCast(ai: AiClient, speakers: string[], request: string): Promise<VoiceRole[]> {
  const fallback = autoCast(speakers);
  try {
    const r = await ai.ask({
      system: 'You cast text-to-speech voices for characters in a short fan edit. Follow the JSON shape exactly.',
      prompt: [
        `Characters: ${JSON.stringify(speakers)}. The creator's request: "${request.slice(0, 400)}".`,
        `Voices: ${JSON.stringify(PIPER_VOICES.map((v) => ({ voice: `piper:${v.id}`, sounds: v.label })))}`,
        'Give each character a different fitting voice and a pitch shift in semitones (-4 deeper to +3 higher, 0 for none). Return JSON {"cast":[{"speaker":"","voice":"","pitch":0}]}.',
      ].join('\n\n'),
      expectJson: true,
      timeoutMs: 60_000,
    });
    const rows: any[] = Array.isArray((r.json as any)?.cast) ? (r.json as any).cast : [];
    const ok = new Set(PIPER_VOICES.map((v) => `piper:${v.id}`));
    return fallback.map((f) => {
      const row = rows.find((x) => x && typeof x.speaker === 'string' && x.speaker.toLowerCase() === f.speaker.toLowerCase());
      return row && ok.has(row.voice) ? { speaker: f.speaker, voice: row.voice, pitch: Number.isFinite(row.pitch) ? Math.max(-6, Math.min(6, row.pitch)) : 0 } : f;
    });
  } catch {
    return fallback;
  }
}

/**
 * Where each voice line plays: at its subtitle, sped up a little (at most 1.35x) when it runs past the
 * next line, and never on top of the previous line.
 */
export function placeVoices(lines: Array<SpokenLine & { file: string; seconds: number }>, reelSeconds: number): PlacedVoice[] {
  const out: PlacedVoice[] = [];
  let free = 0;
  const sorted = [...lines].sort((a, b) => a.start - b.start);
  sorted.forEach((l, i) => {
    const at = Math.max(l.start, free);
    if (at >= reelSeconds - 0.3) return;
    const nextStart = sorted[i + 1]?.start ?? reelSeconds;
    const room = Math.max(0.3, Math.max(l.end + 0.4, nextStart) - at);
    const tempo = Math.min(1.35, Math.max(1, l.seconds / room));
    const seconds = Math.min(l.seconds / tempo, reelSeconds - at);
    out.push({ file: l.file, at: Math.round(at * 1000) / 1000, tempo: Math.round(tempo * 1000) / 1000, seconds: Math.round(seconds * 1000) / 1000 });
    free = at + seconds + 0.05;
  });
  return out;
}

/** ffmpeg args that lay the voices over `input`'s sound, ducking it under each line. Video is copied. */
export function voiceMixArgs(input: string, voices: PlacedVoice[], v: Pick<VoiceSettings, 'duck' | 'volume'>, output: string, hasVideo: boolean): string[] {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', input];
  for (const p of voices) args.push('-i', p.file);
  const r3 = (x: number) => (Math.round(x * 1000) / 1000).toString();
  const when = voices.map((p) => `between(t,${r3(Math.max(0, p.at - 0.08))},${r3(p.at + p.seconds + 0.15)})`).join('+') || '0';
  const lines = [`[0:a]volume=${r3(v.duck)}:enable='${when}'[bed]`];
  voices.forEach((p, i) => {
    const ms = Math.round(p.at * 1000);
    lines.push(`[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo${p.tempo > 1.001 ? `,atempo=${r3(p.tempo)}` : ''},atrim=0:${r3(p.seconds)},volume=${r3(v.volume)},adelay=${ms}|${ms}[v${i}]`);
  });
  lines.push(`[bed]${voices.map((_, i) => `[v${i}]`).join('')}amix=inputs=${voices.length + 1}:duration=first:dropout_transition=0:normalize=0[aout]`);
  args.push('-filter_complex', lines.join(';'), ...(hasVideo ? ['-map', '0:v', '-c:v', 'copy'] : []), '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', ...(hasVideo ? ['-movflags', '+faststart'] : []), output);
  return args;
}

function run(bin: string, args: string[], signal?: AbortSignal, input?: string, timeout = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, signal, cwd: path.dirname(bin) === '.' ? undefined : path.dirname(bin) });
    let err = '';
    const timer = setTimeout(() => child.kill(), timeout);
    child.stderr.on('data', (d) => (err += d));
    child.stdout.on('data', () => undefined);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(err) : reject(new Error(err.trim().split('\n').slice(-2).join(' ') || `${path.basename(bin)} exited with ${code}`));
    });
    if (input !== undefined) child.stdin.end(input, 'utf8');
  });
}

/** Seconds of audio in a file, from `ffmpeg -i`. */
export function mediaSeconds(ffmpeg: string, file: string): Promise<number> {
  return new Promise((resolve) =>
    execFile(ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true, timeout: 20_000 }, (_e, _o, err) => {
      const d = String(err ?? '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      resolve(d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0);
    }),
  );
}

/** Piper first; Windows' own voices if Piper can't be downloaded or fails. */
export function localSynth(o: { ffmpeg: string; tools: SpeechTools; progress?: ToolProgress }): Synth {
  return {
    async speak(text, role, out, signal) {
      const raw = out.replace(/\.wav$/, '.raw.wav');
      let made = false;
      let problem = '';
      if (role.voice.startsWith('piper:')) {
        try {
          const p = await o.tools.piper(role.voice.slice(6), o.progress, signal);
          await run(p.bin, ['--model', p.model, '--output_file', raw], signal, text.replace(/\s+/g, ' '));
          made = fs.existsSync(raw);
        } catch (e) {
          problem = (e as Error).message;
        }
      }
      if (!made && process.platform === 'win32') {
        const sapi = role.voice.startsWith('sapi:') ? role.voice.slice(5) : '';
        const txt = raw + '.txt';
        fs.writeFileSync(txt, text, 'utf8');
        const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ${sapi ? `try { $s.SelectVoice('${sapi.replace(/'/g, "''")}') } catch {}; ` : ''}$s.SetOutputToWaveFile('${raw.replace(/'/g, "''")}'); $s.Speak([IO.File]::ReadAllText('${txt.replace(/'/g, "''")}')); $s.Dispose()`;
        await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], signal);
        fs.rmSync(txt, { force: true });
        made = fs.existsSync(raw);
      }
      if (!made) throw new Error(problem || 'No voice engine is available.');
      // Pitch shift without changing speed, then trim silence at the ends.
      const p = role.pitch ?? 0;
      const k = Math.pow(2, p / 12);
      const shift = Math.abs(p) > 0.05 ? `asetrate=44100*${k.toFixed(4)},aresample=44100,atempo=${(1 / k).toFixed(4)},` : '';
      await run(o.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', raw, '-af', `aresample=44100,${shift}silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse`, '-ac', '1', out], signal);
      fs.rmSync(raw, { force: true });
    },
  };
}

/** Voice every spoken line (cached by text and voice), then mix them into `file` in place. */
export async function voiceOver(o: { ffmpeg: string; synth: Synth; file: string; lines: SpokenLine[]; settings: VoiceSettings; reelSeconds: number; workDir: string; hasVideo: boolean; signal?: AbortSignal; onLine?: (i: number, n: number) => void }): Promise<number> {
  const cast = autoCast([...new Set(o.lines.map((l) => l.speaker))], o.settings.cast);
  const made: Array<SpokenLine & { file: string; seconds: number }> = [];
  for (const [i, l] of o.lines.entries()) {
    o.onLine?.(i, o.lines.length);
    const role = cast.find((r) => r.speaker === l.speaker)!;
    const file = path.join(o.workDir, `voice-${crypto.createHash('sha1').update(JSON.stringify([l.text, role.voice, role.pitch ?? 0])).digest('hex').slice(0, 16)}.wav`);
    if (!fs.existsSync(file)) await o.synth.speak(l.text, role, file, o.signal);
    made.push({ ...l, file, seconds: await mediaSeconds(o.ffmpeg, file) });
  }
  const placed = placeVoices(made.filter((m) => m.seconds > 0.05), o.reelSeconds);
  if (!placed.length) return 0;
  const tmp = o.file.replace(/(\.[a-z0-9]+)$/i, '.voiced$1');
  await run(o.ffmpeg, voiceMixArgs(o.file, placed, o.settings, tmp, o.hasVideo).slice(0), o.signal, undefined, 600_000);
  fs.renameSync(tmp, o.file);
  return placed.length;
}
