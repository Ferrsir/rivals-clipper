// Export targets. Sizes and limits follow each platform's upload guidance (see docs/resolution-guide.md).

import type { ExportFormat, FormatId } from '../../shared/studio';

export const FORMATS: Record<FormatId, ExportFormat> = {
  square: {
    id:'square',label:'Reference square',platform:'TikTok',width:1080,height:1080,fps:30,fpsOptions:[30,60],
    idealSeconds:[10,30],maxSeconds:180,safe:{top:.05,bottom:.08,left:.04,right:.04},crf:17,maxrateKbps:12000,audioKbps:320,
    music:{inAppLibrary:true,copyrightRisk:'medium',note:'Square master matching the imported reference framing. Check the destination preview before posting; use a vertical format when you want full-height 9:16.'},
  },
  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    platform: 'TikTok',
    width: 1080,
    height: 1920,
    fps: 60,
    fpsOptions: [30, 60],
    idealSeconds: [12, 34],
    maxSeconds: 600,
    safe: { top: 0.07, bottom: 0.2, left: 0.05, right: 0.13 },
    crf: 17,
    maxrateKbps: 16000,
    audioKbps: 320,
    music: {
      inAppLibrary: true,
      copyrightRisk: 'medium',
      note: 'Popular songs are safest added in TikTok itself. Export a no-music copy too, then pick the same song in TikTok and set its start to the time shown.',
    },
  },
  reels: {
    id: 'reels',
    label: 'Instagram Reels',
    platform: 'Instagram',
    width: 1080,
    height: 1920,
    fps: 30,
    fpsOptions: [30, 60],
    idealSeconds: [7, 30],
    maxSeconds: 180,
    safe: { top: 0.11, bottom: 0.22, left: 0.05, right: 0.12 },
    crf: 17,
    maxrateKbps: 12000,
    audioKbps: 320,
    music: {
      inAppLibrary: true,
      copyrightRisk: 'high',
      note: 'Instagram mutes or blocks reels with uploaded copyrighted songs more often than TikTok. Use the no-music copy and add the song from Instagram\'s audio picker.',
    },
  },
  shorts: {
    id: 'shorts',
    label: 'YouTube Shorts',
    platform: 'YouTube',
    width: 1080,
    height: 1920,
    fps: 60,
    fpsOptions: [30, 60],
    idealSeconds: [15, 45],
    maxSeconds: 180,
    safe: { top: 0.06, bottom: 0.18, left: 0.05, right: 0.14 },
    crf: 17,
    maxrateKbps: 16000,
    audioKbps: 320,
    music: {
      inAppLibrary: true,
      copyrightRisk: 'medium',
      note: 'Copyrighted songs get claimed (revenue goes to the label). Shorts over 60 s with a claimed song are blocked, so keep those to royalty-free music.',
    },
  },
  youtube: {
    id: 'youtube',
    label: 'YouTube 1080p',
    platform: 'YouTube',
    width: 1920,
    height: 1080,
    fps: 60,
    fpsOptions: [30, 60],
    idealSeconds: [60, 600],
    maxSeconds: 43200,
    safe: { top: 0, bottom: 0.08, left: 0, right: 0 },
    crf: 17,
    maxrateKbps: 24000,
    audioKbps: 384,
    music: {
      inAppLibrary: false,
      copyrightRisk: 'high',
      note: 'Use your own or royalty-free music (YouTube Audio Library, NCS, StreamBeats). Copyrighted songs get claimed or blocked.',
    },
  },
  youtube1440: {
    id: 'youtube1440',
    label: 'YouTube 1440p',
    platform: 'YouTube',
    width: 2560,
    height: 1440,
    fps: 60,
    fpsOptions: [30, 60],
    idealSeconds: [60, 600],
    maxSeconds: 43200,
    safe: { top: 0, bottom: 0.08, left: 0, right: 0 },
    crf: 17,
    maxrateKbps: 40000,
    audioKbps: 384,
    music: {
      inAppLibrary: false,
      copyrightRisk: 'high',
      note: '1440p uploads get YouTube\'s sharper codec even when watched at 1080p. Use your own or royalty-free music.',
    },
  },
};

export const FORMAT_LIST: ExportFormat[] = Object.values(FORMATS);

export function isVertical(f: ExportFormat): boolean {
  return f.height > f.width;
}

export function getFormat(id: string): ExportFormat {
  return FORMATS[id as FormatId] ?? FORMATS.tiktok;
}
