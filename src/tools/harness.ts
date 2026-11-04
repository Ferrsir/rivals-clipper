// Command line for the detection test harness.
//
//   npm run harness -- <video.mp4> [more videos] [--labels labels.json] [--player NAME] [--no-ocr]
//                      [--fps 10] [--from SEC] [--for SEC] [--json report.json]
//
// A labels file next to a video (match1.mp4 -> match1.labels.json) is picked up automatically.
// See docs/local-mode.md for the format and how to record test footage.

import fs from 'node:fs';
import path from 'node:path';
import { candidates } from '../main/studio/ffmpeg-bin';
import { formatReport, readLabels, runHarness, type HarnessReport } from '../main/vision/harness';

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const flagsWithValue = new Set(['--labels', '--player', '--fps', '--from', '--for', '--json']);
  const videos = args.filter((a, i) => !a.startsWith('--') && !flagsWithValue.has(args[i - 1]));
  if (!videos.length) {
    console.log('usage: npm run harness -- <video.mp4> [--labels labels.json] [--player NAME] [--no-ocr] [--fps 10] [--json out.json]');
    process.exit(1);
  }
  const ffmpeg = process.env.FFMPEG_PATH ?? candidates()[0] ?? 'ffmpeg';
  const reports: HarnessReport[] = [];
  for (const video of videos) {
    const auto = video.replace(/\.[^.]+$/, '') + '.labels.json';
    const labelsFile = arg(args, '--labels') ?? (fs.existsSync(auto) ? auto : undefined);
    const labels = labelsFile ? readLabels(labelsFile) : undefined;
    const report = await runHarness({
      ffmpeg,
      video,
      labels,
      fps: Number(arg(args, '--fps')) || 10,
      ocr: !args.includes('--no-ocr'),
      playerName: arg(args, '--player'),
      startSec: Number(arg(args, '--from')) || undefined,
      durationSec: Number(arg(args, '--for')) || undefined,
      onProgress: (s) => process.stderr.write(`\r  ${path.basename(video)}: ${s.toFixed(0)} s`),
    });
    process.stderr.write('\r');
    console.log(formatReport(report));
    reports.push(report);
  }
  const scored = reports.filter((r) => r.kills);
  if (scored.length > 1) {
    const sum = (k: 'truePositives' | 'falsePositives' | 'missed') => scored.reduce((n, r) => n + (r.kills?.[k] ?? 0), 0);
    const tp = sum('truePositives');
    const fp = sum('falsePositives');
    const fn = sum('missed');
    console.log(`\nAll videos: kill precision ${((tp / Math.max(1, tp + fp)) * 100).toFixed(0)}%, recall ${((tp / Math.max(1, tp + fn)) * 100).toFixed(0)}% (${tp} found, ${fp} false, ${fn} missed)`);
  }
  const out = arg(args, '--json');
  if (out) fs.writeFileSync(out, JSON.stringify(reports, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
