// Draws the planned edit: song waveform with beats and drop, clip segments (slow-mo striped),
// kill markers (green on the beat, orange off it) and caption lines.

const ROW = { ruler: 18, music: 40, gap: 6, clips: 44, kills: 14, captions: 20 };
export const TIMELINE_HEIGHT = ROW.ruler + ROW.music + ROW.gap + ROW.kills + ROW.clips + ROW.gap + ROW.captions + 4;

const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

export function clipHue(i) {
  return (i * 67 + 200) % 360;
}

export function drawTimeline(canvas, { timeline, track, selectedUid, playhead }) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const hgt = TIMELINE_HEIGHT;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, hgt);
  const text = css('--text', '#e8eaf0');
  const muted = css('--muted', '#8b93a7');
  const line = css('--line', '#262b36');
  const accent = css('--accent', '#ffcc33');
  g.font = '11px system-ui, "Segoe UI", sans-serif';
  g.textBaseline = 'middle';

  const dur = Math.max(timeline?.duration || 0, 1);
  const pad = 8;
  const scale = (w - pad * 2) / dur;
  const X = (t) => pad + t * scale;

  // Ruler
  const step = dur > 120 ? 10 : dur > 40 ? 5 : dur > 15 ? 2 : 1;
  g.fillStyle = muted;
  g.strokeStyle = line;
  for (let t = 0; t <= dur + 1e-6; t += step) {
    const x = X(t);
    g.fillRect(x, ROW.ruler - 5, 1, 5);
    g.fillText(`${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`, x + 3, 8);
  }
  if (!timeline || !timeline.segments.length) {
    g.fillStyle = muted;
    g.fillText('Add clips to see the edit here.', pad, ROW.ruler + ROW.music / 2);
    return { timeAt: () => 0, clipAt: () => null };
  }

  // Music row
  let y = ROW.ruler;
  g.fillStyle = '#10131a';
  g.fillRect(pad, y, w - pad * 2, ROW.music);
  const an = track?.analysis;
  if (an && an.peaks?.length) {
    g.fillStyle = '#3a4560';
    const mid = y + ROW.music / 2;
    for (let px = 0; px < w - pad * 2; px++) {
      const t = timeline.musicStart + px / scale;
      const i = Math.floor((t / an.durationSec) * an.peaks.length);
      const v = an.peaks[i] ?? 0;
      const hh = Math.max(1, v * (ROW.music / 2 - 3));
      g.fillRect(pad + px, mid - hh, 1, hh * 2);
    }
  } else {
    g.fillStyle = muted;
    g.fillText(track ? 'Finding the beat…' : 'No music', pad + 6, y + ROW.music / 2);
  }
  for (const b of timeline.beats) {
    const isDown = timeline.downbeats.some((d) => Math.abs(d - b) < 1e-3);
    g.fillStyle = isDown ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.14)';
    g.fillRect(X(b), y + (isDown ? 0 : ROW.music * 0.6), 1, isDown ? ROW.music : ROW.music * 0.4);
  }
  if (timeline.drop !== undefined) {
    g.fillStyle = accent;
    g.fillRect(X(timeline.drop) - 1, y, 2, ROW.music);
    g.fillText('DROP', X(timeline.drop) + 4, y + 8);
  }
  y += ROW.music + ROW.gap;

  // Kill markers
  const killY = y + ROW.kills / 2;
  y += ROW.kills;

  // Clip segments
  for (const s of timeline.segments) {
    const x0 = X(s.out[0]);
    const x1 = X(s.out[1]);
    if (s.kind === 'intro') {
      g.fillStyle = '#2b3140';
      g.fillRect(x0, y, x1 - x0, ROW.clips);
      g.fillStyle = text;
      if (x1 - x0 > 40) g.fillText('Intro', x0 + 5, y + ROW.clips / 2);
      continue;
    }
    const hue = clipHue(s.clipIndex);
    const sel = s.clipUid === selectedUid;
    const slow = s.speed < 0.8;
    const fast = s.speed > 1.15;
    g.fillStyle = `hsl(${hue} 55% ${sel ? 46 : 34}%)`;
    g.fillRect(x0, y, Math.max(1, x1 - x0), ROW.clips);
    if (slow) {
      g.save();
      g.beginPath();
      g.rect(x0, y, x1 - x0, ROW.clips);
      g.clip();
      g.strokeStyle = 'rgba(255,255,255,0.18)';
      for (let k = x0 - ROW.clips; k < x1; k += 6) {
        g.beginPath();
        g.moveTo(k, y + ROW.clips);
        g.lineTo(k + ROW.clips, y);
        g.stroke();
      }
      g.restore();
    } else if (fast) {
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(x0, y + ROW.clips - 6, x1 - x0, 6);
    }
  }
  // Clip outlines and labels
  for (const c of timeline.clips) {
    const x0 = X(c.out[0]);
    const x1 = X(c.out[1]);
    g.strokeStyle = c.uid === selectedUid ? text : 'rgba(0,0,0,0.6)';
    g.lineWidth = c.uid === selectedUid ? 2 : 1;
    g.strokeRect(x0 + 0.5, y + 0.5, x1 - x0 - 1, ROW.clips - 1);
    g.lineWidth = 1;
    g.fillStyle = text;
    if (x1 - x0 > 26) g.fillText(String(c.index + 1), x0 + 5, y + 10);
    for (let i = 0; i < c.kills.length; i++) {
      const kx = X(c.kills[i]);
      g.fillStyle = c.onBeat[i] ? '#7ddc8a' : '#ff9f43';
      g.beginPath();
      g.moveTo(kx, killY - 5);
      g.lineTo(kx + 5, killY);
      g.lineTo(kx, killY + 5);
      g.lineTo(kx - 5, killY);
      g.closePath();
      g.fill();
      g.fillRect(kx, killY + 5, 1, ROW.clips + 2);
    }
  }
  y += ROW.clips + ROW.gap;

  // Captions
  for (const c of timeline.captions || []) {
    const x0 = X(c.start);
    const x1 = X(c.end);
    g.fillStyle = '#2a2f3b';
    g.fillRect(x0, y, Math.max(2, x1 - x0 - 2), ROW.captions);
    g.save();
    g.beginPath();
    g.rect(x0, y, x1 - x0 - 4, ROW.captions);
    g.clip();
    g.fillStyle = muted;
    g.fillText(c.text, x0 + 4, y + ROW.captions / 2);
    g.restore();
  }

  if (Number.isFinite(playhead)) {
    g.fillStyle = '#ff4d6d';
    g.fillRect(X(playhead), 0, 2, hgt);
  }

  const timeAt = (px) => Math.max(0, Math.min(dur, (px - pad) / scale));
  const clipAt = (px) => {
    const t = timeAt(px);
    return timeline.clips.find((c) => t >= c.out[0] && t <= c.out[1])?.uid ?? null;
  };
  return { timeAt, clipAt };
}
