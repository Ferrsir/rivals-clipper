// The editor timeline, laid out like Premiere Pro: a timecode ruler with the song's beats, then
// V2 (subtitles, captions and picture overlays), V1 (the clips, with kill markers and thumbnails),
// A1 (each clip's own sound) and A2 (the song, with its volume line and audio jumps).
//
// Tools: Selection (V) selects, trims a clip by dragging its edge, and reorders clips by dragging
// them; Razor (C) splits a clip where you click. The playhead follows the preview and scrubs it.
// Every change goes back to the Studio as a project edit, and the planner re-times the reel.

import { h } from './dom.js';

const RULER = 24;
const TRACKS = [
  { id: 'v2', label: 'V2', name: 'Text & pictures', h: 26 },
  { id: 'v1', label: 'V1', name: 'Clips', h: 52 },
  { id: 'a1', label: 'A1', name: 'Clip sound', h: 34 },
  { id: 'a2', label: 'A2', name: 'Music', h: 52 },
];
const GAP = 2;
export const TIMELINE_HEIGHT = RULER + TRACKS.reduce((s, t) => s + t.h + GAP, 0) + 6;
const EDGE = 7;

export function clipHue(i) {
  return (i * 67 + 200) % 360;
}

const COLORS = {
  bg: '#1b1b1b',
  lane: '#232323',
  laneAlt: '#202020',
  ruler: '#262626',
  tick: '#6b6b6b',
  text: '#d9d9d9',
  muted: '#8c8c8c',
  video: '#8d7fd6',
  videoSel: '#b3a8f0',
  hook: '#d58cc0',
  audio: '#3f9a6c',
  audioSel: '#62c393',
  music: '#2f7f8f',
  text2: '#a1609b',
  overlay: '#c98a3a',
  playhead: '#3d9cff',
  kill: '#7ddc8a',
  killOff: '#ff9f43',
  jump: '#e0505e',
  drop: '#ffcc33',
  level: '#ffd84a',
};

function timecode(t, fps = 30) {
  const s = Math.max(0, t);
  const f = Math.floor((s % 1) * fps + 1e-6);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(Math.floor(s) % 60)}:${p(f)}`;
}

/**
 * cb: onSelect(uid|null), onSeek(t), onTrim(uid, edge, srcTime), onMove(from, to), onSplit(uid, srcTime),
 *     onSelectJump(index|null), onMoveJump(index, at), onAddJump(at), onDelete()
 */
export function createTimeline(cb) {
  const st = { timeline: null, project: null, track: null, sel: null, jump: null, playhead: 0, tool: 'select', snap: true, pps: 0, fit: true, scroll: 0, drag: null };
  const thumbs = new Map();

  const toolBtn = (tool, label, key) =>
    h('button', { class: 'tl-tool', 'data-tool': tool, title: `${label} (${key})`, onclick: () => setTool(tool) }, label);
  const selBtn = toolBtn('select', '▸ Select', 'V');
  const razorBtn = toolBtn('razor', '✂ Razor', 'C');
  const snapBtn = h('button', { class: 'tl-tool on', title: 'Snap edits to the beat (S)', onclick: () => ((st.snap = !st.snap), snapBtn.classList.toggle('on', st.snap)) }, '⌖ Snap');
  const jumpBtn = h('button', { class: 'tl-tool', title: 'Drop the song out for a beat at the playhead (J)', onclick: () => addJump() }, '⏏ Audio jump');
  const zoomOut = h('button', { class: 'tl-tool', title: 'Zoom out (-)', onclick: () => zoom(1 / 1.5) }, '−');
  const zoomIn = h('button', { class: 'tl-tool', title: 'Zoom in (+)', onclick: () => zoom(1.5) }, '+');
  const fitBtn = h('button', { class: 'tl-tool', title: 'Fit the whole reel (\\)', onclick: () => ((st.fit = true), draw()) }, 'Fit');
  const tc = h('span', { class: 'tl-tc' }, timecode(0));
  const hint = h('span', { class: 'tl-hint' }, '');
  const heads = h(
    'div',
    { class: 'tl-heads' },
    h('div', { class: 'tl-head ruler', style: { height: `${RULER}px` } }),
    TRACKS.map((t) => h('div', { class: 'tl-head', style: { height: `${t.h}px`, marginBottom: `${GAP}px` }, title: t.name }, h('b', {}, t.label), h('span', {}, t.name))),
  );
  const canvas = h('canvas', { class: 'tl-canvas', style: { height: `${TIMELINE_HEIGHT}px` } });
  const scroller = h('div', { class: 'tl-scroll' }, canvas);
  const el = h(
    'div',
    { class: 'tl', tabIndex: 0 },
    h('div', { class: 'tl-bar' }, selBtn, razorBtn, snapBtn, h('span', { class: 'tl-sep' }), jumpBtn, h('span', { class: 'tl-sep' }), zoomOut, zoomIn, fitBtn, hint, tc),
    h('div', { class: 'tl-body' }, heads, scroller),
  );
  setTool('select');

  function setTool(tool) {
    st.tool = tool;
    for (const b of [selBtn, razorBtn]) b.classList.toggle('on', b.dataset.tool === tool);
    canvas.style.cursor = tool === 'razor' ? 'crosshair' : 'default';
  }

  const dur = () => Math.max(1, st.timeline?.duration || 0);
  const width = () => scroller.clientWidth || 600;
  const pps = () => (st.fit || !st.pps ? (width() - 16) / dur() : st.pps);
  const X = (t) => 8 + t * pps();
  const T = (x) => Math.max(0, Math.min(dur(), (x - 8) / pps()));

  function zoom(k) {
    const keep = st.playhead;
    st.pps = Math.max(8, Math.min(800, pps() * k));
    st.fit = false;
    draw();
    scroller.scrollLeft = Math.max(0, X(keep) - width() / 2);
  }

  function laneY(id) {
    let y = RULER;
    for (const t of TRACKS) {
      if (t.id === id) return { y, h: t.h };
      y += t.h + GAP;
    }
    return { y: 0, h: 0 };
  }

  /** Beat nearest to t (output seconds), or t itself when snap is off or there is no song. */
  function snapT(t) {
    const beats = st.timeline?.beats ?? [];
    if (!st.snap || !beats.length) return t;
    let best = t;
    let bd = Infinity;
    for (const b of beats) {
      const d = Math.abs(b - t);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return bd * pps() < 12 ? best : t;
  }

  /** Output time -> the clip and source time showing then (never a held frame). */
  function sourceAt(t) {
    const segs = st.timeline?.segments ?? [];
    const s = segs.find((x) => x.kind !== 'intro' && x.kind !== 'hold' && t >= x.out[0] && t < x.out[1]) ?? segs.find((x) => x.kind === 'hold' && t >= x.out[0] && t <= x.out[1]);
    if (!s) return null;
    const src = s.kind === 'hold' ? s.src[1] : s.src[0] + (t - s.out[0]) * s.speed;
    return { uid: s.clipUid, src, seg: s };
  }

  function thumb(clip) {
    const key = `${clip.videoFile}|${clip.in.toFixed(2)}`;
    if (thumbs.has(key)) return thumbs.get(key);
    const entry = { img: null };
    thumbs.set(key, entry);
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = cb.fileUrl(clip.videoFile);
    v.addEventListener('loadeddata', () => (v.currentTime = Math.min(clip.in + 0.3, Math.max(0, (v.duration || 1) - 0.1))), { once: true });
    v.addEventListener('seeked', () => {
      const c = document.createElement('canvas');
      c.width = 96;
      c.height = 54;
      try {
        c.getContext('2d').drawImage(v, 0, 0, 96, 54);
        entry.img = c;
      } catch {
        /* unreadable frame */
      }
      v.removeAttribute('src');
      v.load();
      draw();
    }, { once: true });
    return entry;
  }

  function draw() {
    const tl = st.timeline;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(width(), Math.ceil(X(dur()) + 24));
    canvas.style.width = `${w}px`;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(TIMELINE_HEIGHT * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(TIMELINE_HEIGHT * dpr);
    }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = COLORS.bg;
    g.fillRect(0, 0, w, TIMELINE_HEIGHT);
    g.font = '11px "Segoe UI", system-ui, sans-serif';
    g.textBaseline = 'middle';

    // Lanes
    TRACKS.forEach((t, i) => {
      const { y, h: hh } = laneY(t.id);
      g.fillStyle = i % 2 ? COLORS.laneAlt : COLORS.lane;
      g.fillRect(0, y, w, hh);
    });

    // Ruler: timecode every few seconds, beat ticks, the drop.
    g.fillStyle = COLORS.ruler;
    g.fillRect(0, 0, w, RULER);
    const p = pps();
    const step = [0.5, 1, 2, 5, 10, 30, 60].find((s) => s * p >= 70) ?? 60;
    g.fillStyle = COLORS.muted;
    for (let t = 0; t <= dur() + 1e-6; t += step) {
      const x = X(t);
      g.fillRect(x, RULER - 9, 1, 9);
      g.fillText(timecode(t, tl?.fps ?? 30).slice(3), x + 3, 8);
    }
    for (const b of tl?.beats ?? []) {
      const down = tl.downbeats?.some((d) => Math.abs(d - b) < 1e-3);
      g.fillStyle = down ? '#9a9a9a' : '#555';
      g.fillRect(X(b), RULER - (down ? 6 : 3), 1, down ? 6 : 3);
    }
    if (tl?.drop !== undefined) {
      g.fillStyle = COLORS.drop;
      g.beginPath();
      g.moveTo(X(tl.drop) - 5, RULER - 8);
      g.lineTo(X(tl.drop) + 5, RULER - 8);
      g.lineTo(X(tl.drop), RULER - 1);
      g.fill();
    }

    if (!tl || !tl.segments.length || !st.project) {
      g.fillStyle = COLORS.muted;
      g.fillText('Add clips to see the edit here.', 12, laneY('v1').y + 26);
      drawPlayhead(g);
      return;
    }
    const clips = st.project.clips;
    const byUid = new Map(clips.map((c) => [c.uid, c]));

    // V2: subtitles and captions, then picture overlays under them.
    {
      const { y, h: hh } = laneY('v2');
      for (const c of tl.captions ?? []) block(g, X(c.start), X(c.end), y + 2, hh / 2 - 2, COLORS.text2, c.text);
      for (const ov of st.project.overlays ?? []) {
        const tc = tl.clips.find((c) => c.uid === ov.clipUid);
        const segs = tl.segments.filter((s) => s.clipUid === ov.clipUid && s.kind !== 'hold');
        if (!tc || !segs.length) continue;
        const map = (src) => {
          const s = segs.find((x) => src >= x.src[0] - 1e-3 && src <= x.src[1] + 1e-3);
          return s ? s.out[0] + (src - s.src[0]) / Math.max(1e-3, s.speed) : src < segs[0].src[0] ? tc.out[0] : tc.out[1];
        };
        block(g, X(map(Math.max(ov.from, segs[0].src[0]))), X(map(Math.min(ov.to, segs.at(-1).src[1]))), y + hh / 2 + 1, hh / 2 - 3, COLORS.overlay, (ov.image || '').split(/[\\/]/).pop());
      }
    }

    // V1: clips.
    const v1 = laneY('v1');
    const a1 = laneY('a1');
    tl.clips.forEach((tc, i) => {
      const c = byUid.get(tc.uid);
      if (!c) return;
      const x0 = X(tc.out[0]);
      const x1 = X(tc.out[1]);
      const sel = tc.uid === st.sel;
      const base = c.external ? COLORS.hook : COLORS.video;
      g.fillStyle = sel ? (c.external ? '#e9b3db' : COLORS.videoSel) : base;
      g.fillRect(x0 + 1, v1.y + 2, Math.max(2, x1 - x0 - 2), v1.h - 4);
      // Thumbnail at the head of the clip, like Premiere's "head" thumbnails.
      const th = thumb(c);
      if (th.img && x1 - x0 > 60) g.drawImage(th.img, x0 + 2, v1.y + 15, Math.min(56, x1 - x0 - 4), v1.h - 18);
      // Segments: held frame, slow-mo stripes, jump cuts.
      for (const s of tl.segments.filter((x) => x.clipUid === tc.uid)) {
        const sx0 = X(s.out[0]);
        const sx1 = X(s.out[1]);
        if (s.kind === 'hold') {
          g.fillStyle = 'rgba(0,0,0,0.35)';
          g.fillRect(sx0, v1.y + 2, sx1 - sx0, v1.h - 4);
          g.fillStyle = COLORS.text;
          if (sx1 - sx0 > 30) g.fillText('hold', sx0 + 3, v1.y + v1.h - 9);
        } else if (s.speed < 0.8) {
          g.fillStyle = 'rgba(255,255,255,0.15)';
          for (let k = sx0; k < sx1; k += 5) g.fillRect(k, v1.y + v1.h - 6, 2, 3);
        }
      }
      for (let k = 1; k < tl.segments.length; k++) {
        const a = tl.segments[k - 1];
        const b = tl.segments[k];
        if (a.clipUid === tc.uid && b.clipUid === tc.uid && b.kind !== 'hold' && Math.abs(b.src[0] - a.src[1]) > 0.05) {
          g.fillStyle = '#fff';
          g.fillRect(X(b.out[0]) - 1, v1.y + 2, 2, v1.h - 4);
        }
      }
      // Fades as Premiere-style corner ramps.
      const fade = (sec, atEnd) => {
        if (!sec) return;
        const fx = Math.min(x1 - x0, sec * p);
        g.fillStyle = 'rgba(0,0,0,0.45)';
        g.beginPath();
        if (atEnd) {
          g.moveTo(x1 - 1, v1.y + 2);
          g.lineTo(x1 - 1 - fx, v1.y + 2);
          g.lineTo(x1 - 1, v1.y + v1.h - 2);
        } else {
          g.moveTo(x0 + 1, v1.y + 2);
          g.lineTo(x0 + 1 + fx, v1.y + 2);
          g.lineTo(x0 + 1, v1.y + v1.h - 2);
        }
        g.fill();
      };
      fade(c.fadeIn, false);
      fade(c.fadeOut, true);
      g.strokeStyle = sel ? '#fff' : 'rgba(0,0,0,0.55)';
      g.lineWidth = sel ? 2 : 1;
      g.strokeRect(x0 + 1.5, v1.y + 2.5, Math.max(1, x1 - x0 - 3), v1.h - 5);
      g.lineWidth = 1;
      g.fillStyle = '#111';
      g.save();
      g.beginPath();
      g.rect(x0 + 2, v1.y + 2, Math.max(0, x1 - x0 - 4), 13);
      g.clip();
      g.fillText(`${i + 1} ${c.external ? 'Hook' : c.hero ?? 'Clip'}${c.kills ? ` · ${c.kills}k` : ''}${c.manualTrim ? ' ✎' : ''}`, x0 + 5, v1.y + 9);
      g.restore();
      // Kill markers on the clip's top edge: green on the beat, orange off it.
      tc.kills.forEach((k, j) => {
        const kx = X(k);
        g.fillStyle = tc.onBeat[j] ? COLORS.kill : COLORS.killOff;
        g.beginPath();
        g.moveTo(kx, v1.y + 14);
        g.lineTo(kx + 4, v1.y + 19);
        g.lineTo(kx, v1.y + 24);
        g.lineTo(kx - 4, v1.y + 19);
        g.fill();
        g.fillRect(kx, v1.y + 24, 1, v1.h - 26);
      });

      // A1: the clip's own sound.
      const muted = c.muteGame;
      g.fillStyle = sel ? COLORS.audioSel : muted ? '#3a4a42' : COLORS.audio;
      g.fillRect(x0 + 1, a1.y + 2, Math.max(2, x1 - x0 - 2), a1.h - 4);
      for (const s of tl.segments.filter((x) => x.clipUid === tc.uid && x.kind === 'hold')) {
        g.fillStyle = 'rgba(0,0,0,0.4)';
        g.fillRect(X(s.out[0]), a1.y + 2, X(s.out[1]) - X(s.out[0]), a1.h - 4);
      }
      g.fillStyle = '#0d1a13';
      const label = muted ? 'muted' : [c.normalize ? 'levelled' : '', c.gain && c.gain !== 1 ? `${Math.round(c.gain * 100)}%` : '', c.useMic ? 'mic' : ''].filter(Boolean).join(' · ');
      if (label && x1 - x0 > 40) g.fillText(label, x0 + 5, a1.y + a1.h / 2);
    });

    // Insert marker while dragging a clip to a new place.
    if (st.drag?.type === 'move' && st.drag.moved) {
      const at = st.drag.insertX;
      g.fillStyle = '#fff';
      g.fillRect(at - 1, v1.y, 3, v1.h);
      const ghostX = st.drag.x - st.drag.grab;
      g.globalAlpha = 0.5;
      g.fillStyle = COLORS.videoSel;
      g.fillRect(ghostX, v1.y + 4, st.drag.width, v1.h - 8);
      g.globalAlpha = 1;
    }

    // A2: the song's waveform, its volume line (quiet under a hook), audio jumps, and the end fade.
    {
      const { y, h: hh } = laneY('a2');
      const an = st.track?.analysis;
      g.fillStyle = COLORS.music;
      g.fillRect(X(0), y + 2, X(dur()) - X(0), hh - 4);
      if (an?.peaks?.length) {
        g.fillStyle = 'rgba(0,0,0,0.35)';
        const mid = y + hh / 2;
        for (let px = Math.floor(X(0)); px < X(dur()); px++) {
          const t = (tl.musicStart ?? 0) + T(px);
          const v = an.peaks[Math.floor((t / an.durationSec) * an.peaks.length)] ?? 0;
          const a = Math.max(1, v * (hh / 2 - 4));
          g.fillRect(px, mid - a, 1, a * 2);
        }
      } else if (!st.project.music) {
        g.fillStyle = COLORS.muted;
        g.fillText('No music', X(0) + 6, y + hh / 2);
      }
      const levelAt = (t) => {
        let v = 1;
        for (const tc of tl.clips) {
          const lvl = byUid.get(tc.uid)?.musicLevel;
          if (lvl !== undefined && t >= tc.out[0] && t < tc.out[1]) v = lvl;
        }
        for (const cut of st.project.musicCuts ?? []) if (t >= cut.at && t < cut.at + cut.length) v = 0;
        const fade = st.project.ending?.fade;
        if (fade && t > dur() - fade) v *= Math.max(0, (dur() - t) / fade);
        return v;
      };
      g.strokeStyle = COLORS.level;
      g.lineWidth = 1.5;
      g.beginPath();
      for (let px = Math.floor(X(0)); px <= X(dur()); px += 2) {
        const ly = y + 4 + (1 - levelAt(T(px))) * (hh - 8);
        px === Math.floor(X(0)) ? g.moveTo(px, ly) : g.lineTo(px, ly);
      }
      g.stroke();
      g.lineWidth = 1;
      (st.project.musicCuts ?? []).forEach((cut, i) => {
        const at = st.drag?.type === 'jump' && st.drag.index === i && st.drag.at !== undefined ? st.drag.at : cut.at;
        const cx0 = X(at);
        const cx1 = X(at + cut.length);
        g.fillStyle = i === st.jump ? '#ff8a95' : COLORS.jump;
        g.fillRect(cx0, y + 2, Math.max(3, cx1 - cx0), hh - 4);
        g.fillStyle = '#fff';
        if (cx1 - cx0 > 26) g.fillText('jump', cx0 + 3, y + 10);
      });
    }
    drawPlayhead(g);
  }

  function drawPlayhead(g) {
    const x = X(st.playhead);
    g.fillStyle = COLORS.playhead;
    g.fillRect(x, 0, 1.5, TIMELINE_HEIGHT);
    g.beginPath();
    g.moveTo(x - 6, 0);
    g.lineTo(x + 7.5, 0);
    g.lineTo(x + 7.5, 10);
    g.lineTo(x + 0.75, 16);
    g.lineTo(x - 6, 10);
    g.fill();
    tc.textContent = timecode(st.playhead, st.timeline?.fps ?? 30);
  }

  function block(g, x0, x1, y, hh, color, label) {
    if (x1 - x0 < 1) return;
    g.fillStyle = color;
    g.fillRect(x0 + 1, y, x1 - x0 - 2, hh);
    if (x1 - x0 > 24 && label) {
      g.save();
      g.beginPath();
      g.rect(x0 + 2, y, x1 - x0 - 4, hh);
      g.clip();
      g.fillStyle = '#fff';
      g.fillText(label, x0 + 4, y + hh / 2);
      g.restore();
    }
  }

  // ---------- hit testing ----------

  function hitAt(x, y) {
    const tl = st.timeline;
    if (y < RULER) return { area: 'ruler' };
    const lane = TRACKS.find((t) => {
      const l = laneY(t.id);
      return y >= l.y && y < l.y + t.h;
    })?.id;
    if (!tl) return { area: 'empty' };
    if (lane === 'a2') {
      const i = (st.project?.musicCuts ?? []).findIndex((c) => x >= X(c.at) - 3 && x <= X(c.at + c.length) + 3);
      if (i >= 0) return { area: 'jump', index: i };
    }
    if (lane === 'v1' || lane === 'a1') {
      const tc = tl.clips.find((c) => x >= X(c.out[0]) - 1 && x <= X(c.out[1]) + 1);
      if (tc) {
        const edge = x - X(tc.out[0]) < EDGE ? 'in' : X(tc.out[1]) - x < EDGE ? 'out' : null;
        return { area: 'clip', uid: tc.uid, tc, edge };
      }
    }
    return { area: 'empty', lane };
  }

  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  canvas.addEventListener('pointermove', (e) => {
    if (st.drag) return;
    const { x, y } = local(e);
    const hit = hitAt(x, y);
    if (st.tool === 'razor') {
      canvas.style.cursor = hit.area === 'clip' ? 'crosshair' : 'default';
      hint.textContent = hit.area === 'clip' ? `Split at ${timecode(T(x), st.timeline?.fps ?? 30).slice(3)}` : '';
      return;
    }
    canvas.style.cursor = hit.area === 'clip' && hit.edge ? 'ew-resize' : hit.area === 'clip' || hit.area === 'jump' ? 'grab' : 'default';
    hint.textContent = hit.area === 'clip' && hit.edge ? `Drag to trim the clip's ${hit.edge === 'in' ? 'start' : 'end'}` : hit.area === 'clip' ? 'Drag to move · Del removes' : hit.area === 'jump' ? 'Drag to move · Del removes' : '';
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    el.focus({ preventScroll: true });
    const { x, y } = local(e);
    const hit = hitAt(x, y);
    canvas.setPointerCapture(e.pointerId);
    if (hit.area === 'clip' && st.tool === 'razor') {
      const at = sourceAt(snapT(T(x)));
      if (at && at.uid === hit.uid) cb.onSplit(hit.uid, at.src);
      return;
    }
    if (hit.area === 'clip') {
      st.sel = hit.uid;
      st.jump = null;
      cb.onSelect(hit.uid);
      if (hit.edge) {
        st.drag = { type: 'trim', uid: hit.uid, edge: hit.edge, tc: hit.tc, x0: x, x };
      } else {
        st.drag = { type: 'move', uid: hit.uid, x0: x, x, grab: x - X(hit.tc.out[0]), width: X(hit.tc.out[1]) - X(hit.tc.out[0]), moved: false, insertX: x };
      }
      draw();
      return;
    }
    if (hit.area === 'jump') {
      st.jump = hit.index;
      cb.onSelectJump(hit.index);
      const cut = st.project.musicCuts[hit.index];
      st.drag = { type: 'jump', index: hit.index, grab: T(x) - cut.at, x };
      draw();
      return;
    }
    // Ruler or empty lane: move the playhead (and scrub while dragging).
    if (hit.area === 'empty' && hit.lane) {
      st.sel = null;
      st.jump = null;
      cb.onSelect(null);
    }
    st.drag = { type: 'scrub' };
    seek(T(x));
  });

  canvas.addEventListener('pointermove', (e) => {
    const d = st.drag;
    if (!d) return;
    const { x } = local(e);
    d.x = x;
    if (d.type === 'scrub') seek(T(x));
    else if (d.type === 'move') {
      d.moved ||= Math.abs(x - d.x0) > 4;
      // Insert before the first clip whose middle is right of the pointer.
      const mids = st.timeline.clips.map((c) => (X(c.out[0]) + X(c.out[1])) / 2);
      const idx = mids.findIndex((m) => x < m);
      d.to = idx < 0 ? mids.length : idx;
      d.insertX = idx < 0 ? X(st.timeline.clips.at(-1).out[1]) : X(st.timeline.clips[idx].out[0]);
      draw();
    } else if (d.type === 'trim') {
      hint.textContent = `${d.edge === 'in' ? 'Start' : 'End'} ${x - d.x0 >= 0 ? '+' : '−'}${Math.abs((x - d.x0) / pps()).toFixed(2)} s`;
      draw();
      const g = canvas.getContext('2d');
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.fillRect(x - 1, laneY('v1').y, 2, laneY('v1').h + laneY('a1').h + GAP);
    } else if (d.type === 'jump') {
      d.at = Math.max(0, snapT(T(x) - d.grab));
      draw();
    }
  });

  canvas.addEventListener('pointerup', (e) => {
    const d = st.drag;
    st.drag = null;
    if (!d) return;
    const { x } = local(e);
    if (d.type === 'move' && d.moved && d.to !== undefined) {
      const from = st.project.clips.findIndex((c) => c.uid === d.uid);
      let to = d.to > from ? d.to - 1 : d.to;
      if (from >= 0 && to !== from) cb.onMove(from, to);
    } else if (d.type === 'trim') {
      const dt = (x - d.x0) / pps();
      if (Math.abs(dt) * pps() > 2) {
        // The edge's segment speed turns reel seconds back into clip seconds.
        const segs = st.timeline.segments.filter((s) => s.clipUid === d.uid && s.kind !== 'hold');
        const seg = d.edge === 'in' ? segs[0] : segs.at(-1);
        if (seg) cb.onTrim(d.uid, d.edge, (d.edge === 'in' ? seg.src[0] : seg.src[1]) + dt * Math.max(0.25, seg.speed));
      }
    } else if (d.type === 'jump' && d.at !== undefined) {
      cb.onMoveJump(d.index, d.at);
    }
    draw();
  });

  canvas.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.altKey) {
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1.25 : 0.8);
    } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && !st.fit) {
      e.preventDefault();
      scroller.scrollLeft += e.deltaY;
    }
  }, { passive: false });

  el.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const fps = st.timeline?.fps ?? 30;
    if (k === 'v') setTool('select');
    else if (k === 'c') setTool('razor');
    else if (k === 's') snapBtn.click();
    else if (k === 'j') addJump();
    else if (k === '=' || k === '+') zoom(1.5);
    else if (k === '-') zoom(1 / 1.5);
    else if (k === '\\') ((st.fit = true), draw());
    else if (k === 'arrowleft') seek(Math.max(0, st.playhead - (e.shiftKey ? 5 : 1) / fps));
    else if (k === 'arrowright') seek(Math.min(dur(), st.playhead + (e.shiftKey ? 5 : 1) / fps));
    else if (k === 'home') seek(0);
    else if (k === 'end') seek(dur());
    else if ((k === 'delete' || k === 'backspace') && (st.sel || st.jump !== null)) cb.onDelete(st.jump !== null ? { jump: st.jump } : { uid: st.sel });
    else return;
    e.preventDefault();
    e.stopPropagation();
  });

  function addJump() {
    const tl = st.timeline;
    if (!tl || !st.project?.music) return;
    const beats = tl.beats ?? [];
    const at = beats.length ? beats.reduce((a, b) => (Math.abs(b - st.playhead) < Math.abs(a - st.playhead) ? b : a), beats[0]) : st.playhead;
    const beat = beats.length > 1 ? (beats.at(-1) - beats[0]) / (beats.length - 1) : 0.5;
    cb.onAddJump(at, Math.round(beat * 1000) / 1000);
  }

  function seek(t) {
    st.playhead = t;
    cb.onSeek(t, sourceAt(t));
    draw();
  }

  new ResizeObserver(() => draw()).observe(scroller);

  return {
    el,
    update(next) {
      Object.assign(st, next);
      if (st.jump !== null && !(st.project?.musicCuts ?? [])[st.jump]) st.jump = null;
      draw();
    },
    setPlayhead(t) {
      if (st.drag) return;
      st.playhead = t;
      draw();
    },
    sourceAt,
  };
}
