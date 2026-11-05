// Free, local speech tools, downloaded once on first use into <root>\studio\tools:
//   whisper.cpp (MIT) for subtitles: speech to text, and translation to English.
//   Piper (MIT) for AI voices: text to speech, offline, no account.
// Nothing is sent anywhere; both run on your PC. Windows' own voices are the fallback for speech.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface ToolProgress {
  (message: string, pct?: number): void;
}

const WHISPER_ZIP = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-bin-x64.zip';
const WHISPER_MODEL = (name: string) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;
const PIPER_ZIP = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip';
const PIPER_VOICE = (id: string) => {
  // en_US-ryan-high -> en/en_US/ryan/high/en_US-ryan-high.onnx
  const [loc, name, quality] = id.split('-');
  return `https://huggingface.co/rhasspy/piper-voices/resolve/main/${loc.split('_')[0]}/${loc}/${name}/${quality}/${id}.onnx`;
};

/** Piper voices offered for characters, with a rough description for the AI casting them. */
export const PIPER_VOICES: Array<{ id: string; label: string; sex: 'm' | 'f' }> = [
  { id: 'en_US-ryan-high', label: 'Ryan: confident adult male, American', sex: 'm' },
  { id: 'en_US-joe-medium', label: 'Joe: calm male, American', sex: 'm' },
  { id: 'en_US-norman-medium', label: 'Norman: deep older male, American', sex: 'm' },
  { id: 'en_GB-alan-medium', label: 'Alan: male, British', sex: 'm' },
  { id: 'en_GB-northern_english_male-medium', label: 'Northern: rough male, British', sex: 'm' },
  { id: 'en_US-amy-medium', label: 'Amy: young female, American', sex: 'f' },
  { id: 'en_US-kristin-medium', label: 'Kristin: female, American', sex: 'f' },
  { id: 'en_GB-jenny_dioco-medium', label: 'Jenny: female, British', sex: 'f' },
];

/** Recursively find a file by name (zips unpack into a sub-folder). */
export function findFile(dir: string, names: string[]): string | undefined {
  if (!fs.existsSync(dir)) return undefined;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && names.includes(e.name.toLowerCase())) return p;
    if (e.isDirectory()) {
      const hit = findFile(p, names);
      if (hit) return hit;
    }
  }
  return undefined;
}

async function download(url: string, file: string, progress?: ToolProgress, label = path.basename(file), signal?: AbortSignal): Promise<void> {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const res = await fetch(url, { redirect: 'follow', signal });
  if (!res.ok || !res.body) throw new Error(`Couldn't download ${label} (${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = file + '.part';
  const out = fs.createWriteStream(tmp);
  let got = 0;
  let last = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
      if (progress && Date.now() - last > 500) {
        last = Date.now();
        progress(`Downloading ${label}${total ? ` (${Math.round((got / total) * 100)}%)` : ''}…`, total ? got / total : undefined);
      }
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    fs.renameSync(tmp, file);
  } catch (e) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Windows 10+ ships bsdtar, which unpacks zips. */
function unzip(zip: string, dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  return new Promise((resolve, reject) => execFile('tar', ['-xf', zip, '-C', dir], { windowsHide: true, timeout: 300_000 }, (e, _o, err) => (e ? reject(new Error(String(err) || e.message)) : resolve())));
}

export class SpeechTools {
  constructor(private dir: string) {}

  /** Path to whisper-cli and a model, downloading them the first time (~470 MB for "small"). */
  async whisper(progress?: ToolProgress, model = 'small', signal?: AbortSignal): Promise<{ bin: string; model: string }> {
    if (process.env.WHISPER_CLI && process.env.WHISPER_MODEL) return { bin: process.env.WHISPER_CLI, model: process.env.WHISPER_MODEL };
    const home = path.join(this.dir, 'whisper');
    const names = process.platform === 'win32' ? ['whisper-cli.exe', 'main.exe'] : ['whisper-cli', 'main'];
    let bin = findFile(home, names);
    if (!bin) {
      if (process.platform !== 'win32') throw new Error('Install whisper.cpp and set WHISPER_CLI and WHISPER_MODEL to use subtitles on this system.');
      const zip = path.join(home, 'whisper-bin-x64.zip');
      await download(WHISPER_ZIP, zip, progress, 'the subtitle tool (whisper.cpp)', signal);
      await unzip(zip, home);
      fs.rmSync(zip, { force: true });
      bin = findFile(home, names);
      if (!bin) throw new Error('The subtitle tool downloaded but whisper-cli.exe was not in it.');
    }
    const modelFile = path.join(home, `ggml-${model}.bin`);
    await download(WHISPER_MODEL(model), modelFile, progress, `the ${model} speech model`, signal);
    return { bin, model: modelFile };
  }

  /** Path to piper and a voice, downloading them the first time (~25 MB + ~60 MB per voice). */
  async piper(voice: string, progress?: ToolProgress, signal?: AbortSignal): Promise<{ bin: string; model: string }> {
    const home = path.join(this.dir, 'piper');
    const names = process.platform === 'win32' ? ['piper.exe'] : ['piper'];
    let bin = process.env.PIPER_BIN || findFile(home, names);
    if (!bin) {
      if (process.platform !== 'win32') throw new Error('Install Piper and set PIPER_BIN to use AI voices on this system.');
      const zip = path.join(home, 'piper_windows_amd64.zip');
      await download(PIPER_ZIP, zip, progress, 'the voice tool (Piper)', signal);
      await unzip(zip, home);
      fs.rmSync(zip, { force: true });
      bin = findFile(home, names);
      if (!bin) throw new Error('The voice tool downloaded but piper.exe was not in it.');
    }
    if (!/^[a-z]{2}_[A-Z]{2}-[a-z_]+-(x_low|low|medium|high)$/.test(voice)) throw new Error(`Unknown voice ${voice}.`);
    const voices = process.env.PIPER_VOICES || path.join(home, 'voices');
    const model = path.join(voices, `${voice}.onnx`);
    await download(PIPER_VOICE(voice), model, progress, `the ${voice.split('-')[1]} voice`, signal);
    await download(PIPER_VOICE(voice) + '.json', model + '.json', undefined, undefined, signal);
    return { bin, model };
  }
}
