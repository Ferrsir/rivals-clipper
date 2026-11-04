// Music suggestions that depend on where the reel is going and which edit style it uses.
// Ranks your own library by tempo, energy, drop and licence fit, and lists where to find more.

import type { ExportFormat, MusicSource, MusicSuggestion, MusicTrack, StyleRecipe } from '../../shared/studio';

interface Profile {
  bpm: [number, number];
  energy: [number, number];
  wantsDrop: boolean;
  label: string;
}

export function profileFor(style: StyleRecipe, format: ExportFormat): Profile {
  const short = format.height > format.width;
  switch (style.id) {
    case 'velocity':
      return { bpm: [125, 170], energy: [0.65, 1], wantsDrop: true, label: 'fast, hard-hitting tracks with a clear drop (phonk, hardstyle, trap)' };
    case 'beat-cuts':
      return { bpm: [110, 160], energy: [0.55, 1], wantsDrop: true, label: 'punchy tracks with a steady beat' };
    case 'story':
      return { bpm: [85, 160], energy: [0.45, 1], wantsDrop: true, label: 'songs with a vocal build-up and a big drop, so the intro can talk and the gameplay hits on the drop' };
    case 'cinematic':
      return { bpm: [70, 125], energy: [0.3, 0.85], wantsDrop: !short, label: 'atmospheric or orchestral tracks that build' };
    case 'raw':
      return { bpm: [80, 150], energy: [0.2, 0.7], wantsDrop: false, label: 'background beats that sit under game sound and commentary' };
    default:
      return { bpm: [100, 160], energy: [0.5, 1], wantsDrop: true, label: 'upbeat tracks' };
  }
}

/** Tempo fit, treating half and double time as the same feel. */
function tempoFit(bpm: number, [lo, hi]: [number, number]): number {
  let best = 0;
  for (const b of [bpm, bpm * 2, bpm / 2]) {
    if (b >= lo && b <= hi) return 1;
    const d = b < lo ? (lo - b) / lo : (b - hi) / hi;
    best = Math.max(best, Math.max(0, 1 - d * 4));
  }
  return best;
}

export function licenceWarning(t: Pick<MusicTrack, 'license'>, format: ExportFormat, reelSeconds: number): string | undefined {
  const safe = t.license === 'own' || t.license === 'royalty-free';
  if (safe) return undefined;
  if (format.platform === 'YouTube') {
    if (format.id === 'shorts' && reelSeconds > 60) return 'Shorts over 60 s with a copyrighted song get blocked. Use royalty-free music or keep it under a minute.';
    if (format.id === 'shorts') return 'YouTube may claim this song (the label gets the ad money). Mark it royalty-free if it is.';
    return 'Copyrighted songs get claimed or blocked on YouTube videos. Use your own or royalty-free music.';
  }
  if (format.platform === 'Instagram') return 'Instagram often mutes uploaded copyrighted songs. Export the no-music copy and add this song in Instagram.';
  return 'If TikTok mutes it, export the no-music copy and add the song from TikTok\'s sound picker.';
}

export function suggestFromLibrary(
  tracks: MusicTrack[],
  style: StyleRecipe,
  format: ExportFormat,
  reelSeconds: number,
  now = Date.now(),
): MusicSuggestion[] {
  const prof = profileFor(style, format);
  const out: MusicSuggestion[] = [];
  for (const t of tracks) {
    const a = t.analysis;
    if (!a) continue;
    const reasons: string[] = [];
    const warnings: string[] = [];
    let score = 0;

    const tf = tempoFit(a.bpm, prof.bpm);
    score += 3 * tf;
    if (tf >= 1) reasons.push(`${Math.round(a.bpm)} BPM suits this style`);
    else if (tf < 0.5) warnings.push(`${Math.round(a.bpm)} BPM is ${a.bpm < prof.bpm[0] ? 'slow' : 'fast'} for this style`);

    const [elo, ehi] = prof.energy;
    const ef = a.energy >= elo && a.energy <= ehi ? 1 : Math.max(0, 1 - Math.min(Math.abs(a.energy - elo), Math.abs(a.energy - ehi)) * 3);
    score += 2 * ef;
    if (ef >= 1 && a.energy >= 0.7) reasons.push('high energy');

    let start = 0;
    const drop = a.drops[0];
    if (prof.wantsDrop) {
      if (drop !== undefined && drop >= 2) {
        score += 2;
        reasons.push(`drop at ${fmtTime(drop)}`);
        start = Math.max(0, drop - Math.min(8, reelSeconds * 0.35));
      } else {
        score -= 0.5;
        warnings.push('no clear drop found');
      }
    }
    const usable = a.durationSec - start;
    if (usable < reelSeconds) {
      score -= 2 * Math.min(1, (reelSeconds - usable) / reelSeconds) + 0.5;
      warnings.push(`only ${Math.floor(usable)} s of song from there, the reel needs about ${Math.ceil(reelSeconds)} s`);
    }

    if (a.confidence < 0.4) {
      score -= 1;
      warnings.push('the beat is hard to follow, so cuts may feel off');
    } else if (a.confidence > 0.75) score += 0.5;

    const lw = licenceWarning(t, format, reelSeconds);
    if (lw) {
      warnings.push(lw);
      score -= format.platform === 'YouTube' ? 3 : 0.5;
    } else reasons.push(t.license === 'own' ? 'your own music' : 'royalty-free');

    if (t.lastUsedAt && now - t.lastUsedAt < 3 * 86400_000) {
      score -= 0.75;
      warnings.push('you used this in the last few days');
    }

    out.push({ trackId: t.id, score: Math.round(score * 100) / 100, suggestedStart: Math.round(start * 100) / 100, reasons, warnings });
  }
  return out.sort((x, y) => y.score - x.score);
}

export function sourcesFor(format: ExportFormat, style: StyleRecipe): MusicSource[] {
  const genre = style.id === 'cinematic' ? 'cinematic' : style.id === 'raw' ? 'lofi' : 'phonk';
  const youtube: MusicSource[] = [
    { name: 'YouTube Audio Library', url: 'https://studio.youtube.com/channel/UC/music', why: 'Free and safe on YouTube. Filter by genre and mood.', youtubeSafe: true },
    { name: 'NCS (NoCopyrightSounds)', url: 'https://ncs.io/', why: 'Gaming-montage staples. Free with a credit in the description.', youtubeSafe: true },
    { name: 'StreamBeats', url: 'https://www.streambeats.com/', why: 'Made for streamers and creators, free on every platform.', youtubeSafe: true },
    { name: 'Pixabay Music', url: `https://pixabay.com/music/search/${genre}/`, why: 'Free to use, no credit needed.', youtubeSafe: true },
  ];
  if (format.platform === 'TikTok') {
    return [
      { name: 'TikTok trending songs', url: 'https://ads.tiktok.com/business/creativecenter/inspiration/popular/music/pc/en', why: 'What\'s trending right now. Cut to a copy you own, then add the official sound in TikTok.', youtubeSafe: false },
      ...youtube.slice(1),
    ];
  }
  if (format.platform === 'Instagram') {
    return [
      { name: 'Instagram audio picker', url: 'https://www.instagram.com/reels/', why: 'Add the song in the app for full reach. Cut to a copy you own, then post the no-music version.', youtubeSafe: false },
      ...youtube.slice(1),
    ];
  }
  return youtube;
}

export function aiMusicPrompt(o: { format: ExportFormat; style: StyleRecipe; reelSeconds: number; heroes: string[]; tags: string[]; library: Array<{ title: string; artist?: string; bpm?: number }> }): string {
  return [
    `I'm making a ${Math.round(o.reelSeconds)}-second Marvel Rivals gameplay edit for ${o.format.label} in a "${o.style.name}" style (${o.style.description}).`,
    o.heroes.length ? `Heroes in it: ${[...new Set(o.heroes)].join(', ')}.` : '',
    o.tags.length ? `Highlights: ${[...new Set(o.tags)].slice(0, 12).join(', ')}.` : '',
    `Music licensing on ${o.format.platform}: ${o.format.music.note}`,
    o.library.length ? `Songs I already have: ${o.library.slice(0, 40).map((t) => `${t.title}${t.artist ? ` by ${t.artist}` : ''}${t.bpm ? ` (${Math.round(t.bpm)} BPM)` : ''}`).join('; ')}.` : '',
    'Suggest 8 songs that would suit this edit: real, findable tracks, matching the platform\'s licensing (YouTube needs royalty-free or no-copyright music).',
    'Reply as JSON: {"ideas":[{"title":"","artist":"","genre":"","why":"one short sentence","where":"where to get it legally","search":"search words to find it"}]}',
  ]
    .filter(Boolean)
    .join('\n');
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
