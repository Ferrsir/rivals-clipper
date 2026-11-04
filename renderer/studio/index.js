// The Editing Studio. Mounted by the shell into #studio-root (see docs/studio-interface.md).
// State lives here; the main process plans, renders and stores everything (studio:* channels).

import { api } from './api.js';
import { clear, debounce, fileUrl, fmtTime, h, select, slider, toast, toggle } from './dom.js';
import { TIMELINE_HEIGHT, clipHue, drawTimeline } from './timeline.js';

const S = {
  init: null,
  project: null,
  projects: [],
  timeline: null,
  library: [],
  tracks: [],
  sel: null,
  leftTab: 'clips',
  rightTab: 'style',
  job: null,
  preview: null,
  suggest: null,
  aiIdeas: null,
  filters: { q: '', minKills: 0, sort: 'score' },
  busy: {},
  safeZones: true,
  styleUndo: null,
};
let root;
const E = {};
let hit = { timeAt: () => 0, clipAt: () => null };
const audio = new Audio();
let playingTrack = null;

const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

// ---------- helpers ----------

const fmt = () => S.init.formats.find((f) => f.id === S.project.format) ?? S.init.formats[0];
const vertical = () => fmt().height > fmt().width;
const trackOf = (id) => S.tracks.find((t) => t.id === id);
const currentTrack = () => (S.project?.music ? trackOf(S.project.music.trackId) : undefined);
const clipByUid = (uid) => S.project.clips.find((c) => c.uid === uid);
const planKey = () => JSON.stringify(S.timeline?.segments?.map((s) => [s.src, s.out]) ?? []) + JSON.stringify(S.project?.style) + JSON.stringify(S.project?.mix) + (S.project?.music?.file ?? '') + JSON.stringify(S.project?.captions) + JSON.stringify(S.project?.intro);
const pct = (v) => `${Math.round(v * 100)}%`;
const x100 = (v) => `${Math.round(v * 100)}`;

function busy(key, on) {
  S.busy[key] = on;
}

async function guarded(key, fn, okMsg) {
  if (S.busy[key]) return;
  busy(key, true);
  renderAll();
  try {
    const r = await fn();
    if (okMsg) toast(root, okMsg);
    return r;
  } catch (err) {
    toast(root, err.message || String(err), 'error', 7000);
  } finally {
    busy(key, false);
    renderAll();
  }
}

// ---------- persistence ----------

// The pending save is bound to the project that was edited, so switching reels can't save the wrong one.
const saveSoon = debounce(async (proj = S.project) => {
  if (!proj) return;
  try {
    const saved = await api.projects.save(proj);
    proj.updatedAt = saved.updatedAt;
    const row = S.projects.find((p) => p.id === saved.id);
    if (row) Object.assign(row, { name: saved.name, updatedAt: saved.updatedAt, clips: saved.clips.length });
  } catch (err) {
    toast(root, `Couldn't save: ${err.message}`, 'error');
  }
}, 600);

const planSoon = debounce(async () => {
  if (!S.project) return;
  try {
    S.timeline = await api.plan(S.project);
  } catch (err) {
    S.timeline = null;
    toast(root, `Couldn't plan the edit: ${err.message}`, 'error');
  }
  renderCenter();
  renderStrip();
  drawTL();
}, 120);

/** Apply a change to the project, then save and re-plan. */
function change(fn, parts = []) {
  fn(S.project);
  saveSoon(S.project);
  planSoon();
  for (const p of parts) p();
}

async function openProject(id) {
  if (saveSoon.pending()) saveSoon.flush();
  const p = id ? await api.projects.get(id) : null;
  S.project = p ?? (await api.projects.create({ format: 'tiktok', styleId: 'story' }));
  if (!S.projects.some((x) => x.id === S.project.id)) S.projects.unshift({ id: S.project.id, name: S.project.name, updatedAt: S.project.updatedAt, clips: S.project.clips.length });
  store.set('studio:last', S.project.id);
  S.sel = null;
  S.preview = null;
  S.suggest = null;
  S.aiIdeas = null;
  S.styleUndo = null;
  planSoon.flush();
  refreshSuggestions();
  renderAll();
}

// ---------- mount ----------

export async function mount(el) {
  root = el;
  root.classList.remove('panel');
  root.classList.add('st');
  root.closest('.view')?.classList.add('st-view');
  if (!document.querySelector('link[data-studio]')) {
    document.head.append(h('link', { rel: 'stylesheet', href: 'studio/studio.css', 'data-studio': '1' }));
  }
  clear(root, h('div', { class: 'st-loading' }, 'Opening the studio…'));

  try {
    const [init, projects, library, tracks] = await Promise.all([api.init(), api.projects.list(), api.clips(), api.music.list()]);
    Object.assign(S, { init, projects, library, tracks });
  } catch (err) {
    clear(root, h('div', { class: 'st-loading error' }, `The studio couldn't start: ${err.message}`));
    return;
  }
  build();
  api.on('studio:render:progress', onProgress);
  api.on('studio:music:progress', (m) => toast(root, m.message));
  api.on('studio:music:updated', (t) => {
    upsertTrack(t);
    renderLeft();
    drawTL();
  });
  window.clipper?.onClip?.(async () => {
    S.library = await api.clips().catch(() => S.library);
    if (S.leftTab === 'clips') renderLeft();
  });
  audio.addEventListener('ended', () => {
    playingTrack = null;
    renderLeft();
  });
  window.addEventListener('resize', debounce(drawTL, 50));
  document.addEventListener('keydown', onKey);
  await openProject(store.get('studio:last'));
  api.music
    .analyzePending()
    .then((t) => {
      S.tracks = t;
      renderLeft();
    })
    .catch(() => undefined);
}

function upsertTrack(t) {
  const i = S.tracks.findIndex((x) => x.id === t.id);
  if (i >= 0) S.tracks[i] = t;
  else S.tracks.unshift(t);
}

function build() {
  E.top = h('div', { class: 'st-top' });
  E.left = h('aside', { class: 'st-left' });
  E.center = h('section', { class: 'st-center' });
  E.right = h('aside', { class: 'st-right' });
  E.canvas = h('canvas', { class: 'st-canvas', style: { height: `${TIMELINE_HEIGHT}px` } });
  E.canvas.addEventListener('click', (e) => {
    const rect = E.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const uid = hit.clipAt(x);
    if (uid) selectClip(uid);
    const v = E.center.querySelector('video.st-preview');
    if (v && S.preview) v.currentTime = hit.timeAt(x);
  });
  E.strip = h('div', { class: 'st-strip' });
  E.banner = h('div', { class: 'st-banner hidden' });
  clear(
    root,
    E.banner,
    E.top,
    h('div', { class: 'st-main' }, E.left, E.center, E.right),
    h('div', { class: 'st-bottom' }, E.canvas, E.strip),
  );
  if (!S.init.ffmpeg.ok) {
    E.banner.classList.remove('hidden');
    E.banner.textContent = `Rendering is unavailable: ${S.init.ffmpeg.problem}`;
  }
}

function renderAll() {
  if (!S.project || !E.top) return;
  renderTop();
  renderLeft();
  renderCenter();
  renderRight();
  renderStrip();
  drawTL();
}

// ---------- top bar ----------

function renderTop() {
  const p = S.project;
  const projSel = h(
    'select',
    {
      class: 'st-project',
      title: 'Your reels',
      onchange: async (e) => {
        if (e.target.value === '__new') {
          if (saveSoon.pending()) saveSoon.flush();
          const created = await api.projects.create({ format: p.format, styleId: p.style.id });
          S.projects.unshift({ id: created.id, name: created.name, updatedAt: created.updatedAt, clips: 0 });
          await openProject(created.id);
        } else await openProject(e.target.value);
      },
    },
    S.projects.map((x) => h('option', { value: x.id, selected: x.id === p.id }, x.name)),
    h('option', { value: '__new' }, '+ New reel'),
  );
  const name = h('input', {
    class: 'st-name',
    value: p.name,
    maxlength: 80,
    title: 'Reel name (used in the file name)',
    oninput: (e) =>
      change((pr) => {
        pr.name = e.target.value;
        const row = S.projects.find((x) => x.id === pr.id);
        if (row) row.name = e.target.value;
      }),
    onchange: () => renderTop(),
  });
  const formats = h(
    'div',
    { class: 'st-seg', role: 'group', 'aria-label': 'Format' },
    S.init.formats.map((f) =>
      h(
        'button',
        {
          class: f.id === p.format ? 'on' : '',
          title: `${f.width}×${f.height}, ${f.fps} fps. Best at ${f.idealSeconds[0]}–${f.idealSeconds[1]} s.`,
          onclick: () =>
            change(
              (pr) => {
                pr.format = f.id;
                pr.fps = f.fps;
                S.preview = null;
              },
              [renderTop, renderCenter, renderRight, refreshSuggestions],
            ),
        },
        f.label.replace('Instagram ', '').replace('YouTube ', 'YT '),
      ),
    ),
  );
  const rendering = S.job && !['done', 'error', 'cancelled'].includes(S.job.stage);
  clear(
    E.top,
    projSel,
    name,
    formats,
    h('div', { class: 'st-spacer' }),
    h(
      'div',
      { class: 'st-menu' },
      h('button', { title: 'Duplicate this reel', onclick: async () => {
        if (saveSoon.pending()) saveSoon.flush();
        const d = await api.projects.duplicate(p.id);
        S.projects.unshift({ id: d.id, name: d.name, updatedAt: d.updatedAt, clips: d.clips.length });
        await openProject(d.id);
      } }, 'Duplicate'),
      h('button', { title: 'Delete this reel (your clips and exports stay)', onclick: async () => {
        if (!confirm(`Delete "${p.name}"? Your clips and exported videos are kept.`)) return;
        saveSoon.cancel();
        await api.projects.remove(p.id);
        S.projects = S.projects.filter((x) => x.id !== p.id);
        await openProject(S.projects[0]?.id);
      } }, 'Delete'),
    ),
    h('button', { class: 'st-btn', disabled: rendering || !p.clips.length || !S.init.ffmpeg.ok, onclick: () => startRender({ preview: true }) }, 'Preview'),
    h('button', { class: 'st-btn primary', disabled: rendering || !p.clips.length || !S.init.ffmpeg.ok, onclick: openExport }, 'Export'),
  );
}

// ---------- left: clips and music ----------

function renderLeft() {
  if (!E.left || !S.project) return;
  const tabs = h(
    'div',
    { class: 'st-tabs' },
    [['clips', `Clips (${S.library.length})`], ['music', `Music (${S.tracks.length})`]].map(([id, label]) =>
      h('button', { class: S.leftTab === id ? 'on' : '', onclick: () => ((S.leftTab = id), renderLeft()) }, label),
    ),
  );
  clear(E.left, tabs, S.leftTab === 'clips' ? clipsPanel() : musicPanel());
}

const thumbObserver = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const v = en.target;
      if (!v.src && v.dataset.src) v.src = v.dataset.src;
      thumbObserver.unobserve(v);
    }
  },
  { rootMargin: '200px' },
);

function clipsPanel() {
  const f = S.filters;
  const q = f.q.trim().toLowerCase();
  let list = S.library.filter((c) => {
    const kills = c.reel.kills;
    if (kills < f.minKills) return false;
    if (!q) return true;
    return [c.hero, c.match?.map, ...(c.tags || [])].filter(Boolean).join(' ').toLowerCase().includes(q);
  });
  list = list.sort((a, b) => (f.sort === 'new' ? b.createdAt - a.createdAt : f.sort === 'kills' ? b.reel.kills - a.reel.kills || b.score - a.score : b.score - a.score));
  const inReel = new Map();
  for (const c of S.project.clips) inReel.set(c.videoFile, (inReel.get(c.videoFile) ?? 0) + 1);
  const ai = S.init.ai.signedIn;
  const target = fmt().idealSeconds[1];

  const controls = h(
    'div',
    { class: 'st-filters' },
    h('input', { type: 'search', placeholder: 'Search', title: 'Search by hero, map or tag', value: f.q, oninput: debounce((e) => ((f.q = e.target.value), renderLeft(), focusSearch()), 200) }),
    select({ value: f.minKills, options: [[0, 'Any kills'], [2, '2+ kills'], [3, '3+ kills'], [4, '4+ kills']], onChange: (v) => ((f.minKills = Number(v)), renderLeft()) }),
    select({ value: f.sort, options: [['score', 'Best'], ['kills', 'Most kills'], ['new', 'Newest']], onChange: (v) => ((f.sort = v), renderLeft()) }),
  );
  const actions = h(
    'div',
    { class: 'st-row' },
    h('button', { class: 'st-btn small', disabled: S.busy.fill, title: `Adds your best unused clips until the reel is about ${target} s`, onclick: () => guarded('fill', async () => {
      const add = await api.autoFill(S.project, target);
      if (!add.length) throw new Error('No more clips to add.');
      change((p) => p.clips.push(...add), [renderLeft, renderStrip]);
    }, null) }, S.busy.fill ? 'Adding…' : `Fill ~${target}s with best`),
    h('button', { class: 'st-btn small', disabled: !ai || S.busy.pick, title: ai ? 'Claude/ChatGPT picks and orders clips for a story' : 'Sign in under Settings, Account to use AI', onclick: () => guarded('pick', async () => {
      const add = await api.ai.pickClips(S.project, target);
      if (!add.length) throw new Error('The AI did not pick any clips.');
      change((p) => (p.clips = add), [renderLeft, renderStrip]);
    }, 'AI picked your clips') }, S.busy.pick ? 'Thinking…' : 'AI pick'),
  );
  const grid = h('div', { class: 'st-cliplist' });
  if (!S.library.length) {
    grid.append(h('p', { class: 'st-empty' }, 'No clips yet. Leave the clipper running while you play, and every kill streak shows up here.'));
  } else if (!list.length) grid.append(h('p', { class: 'st-empty' }, 'No clips match.'));
  for (const c of list.slice(0, 200)) {
    const n = inReel.get(c.videoFile) ?? 0;
    const firstKill = c.reel.hits[0] ?? 0;
    const v = h('video', { muted: true, preload: 'metadata', playsInline: true, dataset: { src: `${fileUrl(c.videoFile)}#t=${Math.max(0, firstKill - 0.3).toFixed(2)}` } });
    thumbObserver.observe(v);
    const card = h(
      'div',
      {
        class: 'st-clip' + (n ? ' in' : ''),
        onmouseenter: () => {
          if (!v.src) v.src = v.dataset.src;
          v.currentTime = Math.max(0, firstKill - 1.5);
          v.play().catch(() => undefined);
        },
        onmouseleave: () => v.pause(),
      },
      v,
      h(
        'div',
        { class: 'st-clip-meta' },
        h('div', { class: 'st-clip-title' }, `${c.reel.kills} kill${c.reel.kills === 1 ? '' : 's'}`, h('span', { class: 'muted' }, ` · ${c.hero ?? 'Unknown'}`)),
        h('div', { class: 'st-clip-sub' }, `${fmtTime(c.durationMs / 1000)} · score ${c.score}${c.rating ? ' · ' + '★'.repeat(c.rating) : ''}`),
        h('div', { class: 'st-tags' }, (c.reel.tags || []).slice(0, 4).join(' ')),
      ),
      h('button', { class: 'st-add', title: n ? `In the reel ${n === 1 ? 'once' : n + ' times'}. Add it again` : 'Add to the reel', onclick: () => {
        change((p) => p.clips.push({ ...c.reel, uid: Math.random().toString(36).slice(2, 10) }), [renderLeft, renderStrip]);
      } }, '+'),
    );
    grid.append(card);
  }
  return h('div', { class: 'st-panel' }, controls, actions, grid);
}

function focusSearch() {
  const s = E.left.querySelector('input[type=search]');
  if (s) {
    s.focus();
    s.setSelectionRange(s.value.length, s.value.length);
  }
}

const LICENSES = [
  ['unknown', 'Licence: not sure'],
  ['platform-only', 'TikTok/IG sound only'],
  ['royalty-free', 'Royalty-free'],
  ['own', 'My own / licensed'],
];

function musicPanel() {
  const p = S.project;
  const f = fmt();
  const cur = currentTrack();
  const blocks = [];
  blocks.push(
    h(
      'div',
      { class: 'st-row' },
      h('button', { class: 'st-btn small', disabled: S.busy.import, onclick: () => guarded('import', async () => {
        const added = await api.music.import();
        for (const t of added) upsertTrack(t);
        refreshSuggestions();
        if (added.length && !p.music) useTrack(added[0]);
      }, null) }, S.busy.import ? 'Adding…' : 'Add music'),
      h('button', { class: 'st-btn small ghost', onclick: () => api.openFolder('music') }, 'Open folder'),
    ),
    h('p', { class: 'st-note' }, f.music.note),
  );
  if (cur || p.music) {
    blocks.push(
      h(
        'div',
        { class: 'st-current' },
        h('div', { class: 'st-label' }, 'In this reel'),
        h('div', { class: 'st-track-title' }, p.music.title),
        cur?.analysis ? h('div', { class: 'st-clip-sub' }, `${Math.round(cur.analysis.bpm)} BPM · ${fmtTime(cur.analysis.durationSec)} · starts at ${fmtTime(S.timeline?.musicStart ?? 0, true)}${p.music.start === 'auto' ? ' (auto)' : ''}`) : h('div', { class: 'st-clip-sub' }, cur?.analysisError ? `Couldn't read it: ${cur.analysisError}` : 'Finding the beat…'),
        h('button', { class: 'st-btn small ghost', onclick: () => change((pr) => (pr.music = null), [renderLeft, renderCenter]) }, 'Remove music'),
      ),
    );
  }
  // Suggestions
  const sug = S.suggest;
  const sugBox = h('div', { class: 'st-section' }, h('h3', {}, `Suggested for ${f.label}`));
  if (!sug) sugBox.append(h('p', { class: 'st-note' }, 'Loading…'));
  else {
    const top = sug.ranked.slice(0, 4);
    if (!top.length) sugBox.append(h('p', { class: 'st-note' }, 'Add some songs and I\'ll rank them for this format and style.'));
    for (const s of top) {
      const t = trackOf(s.trackId);
      if (!t) continue;
      sugBox.append(
        h(
          'div',
          { class: 'st-sug' + (p.music?.trackId === t.id ? ' on' : '') },
          h('div', { class: 'st-track-title' }, t.title, t.artist ? h('span', { class: 'muted' }, ` · ${t.artist}`) : null),
          s.reasons.length ? h('div', { class: 'st-good' }, s.reasons.join(' · ')) : null,
          s.warnings.length ? h('div', { class: 'st-warn' }, s.warnings.join(' ')) : null,
          p.music?.trackId === t.id ? h('span', { class: 'st-badge' }, 'In use') : h('button', { class: 'st-btn small', onclick: () => useTrack(t) }, 'Use'),
        ),
      );
    }
    sugBox.append(h('h3', {}, 'Find more'));
    for (const src of sug.sources) {
      sugBox.append(h('div', { class: 'st-source' }, h('a', { href: '#', onclick: (e) => (e.preventDefault(), api.openExternal(src.url)) }, src.name), h('span', { class: 'muted' }, ` ${src.why}`)));
    }
  }
  const ai = S.init.ai.signedIn;
  sugBox.append(
    h('button', { class: 'st-btn small', disabled: !ai || S.busy.ideas, title: ai ? '' : 'Sign in under Settings, Account to use AI', onclick: () => guarded('ideas', async () => (S.aiIdeas = await api.music.aiIdeas(p)), null) }, S.busy.ideas ? 'Asking…' : 'Ask AI for song ideas'),
  );
  if (S.aiIdeas?.length) {
    for (const idea of S.aiIdeas) {
      sugBox.append(
        h(
          'div',
          { class: 'st-idea' },
          h('div', { class: 'st-track-title' }, idea.title, idea.artist ? h('span', { class: 'muted' }, ` · ${idea.artist}`) : null),
          h('div', { class: 'st-clip-sub' }, [idea.genre, idea.where].filter(Boolean).join(' · ')),
          idea.why ? h('div', { class: 'st-note' }, idea.why) : null,
          h('a', { href: '#', onclick: (e) => (e.preventDefault(), api.openExternal(`https://www.youtube.com/results?search_query=${encodeURIComponent(idea.search)}`)) }, 'Search'),
        ),
      );
    }
  }
  blocks.push(sugBox);

  // Library
  const libBox = h('div', { class: 'st-section' }, h('h3', {}, 'Your music'));
  if (!S.tracks.length) libBox.append(h('p', { class: 'st-note' }, 'Add MP3, WAV, M4A or FLAC files, or drop them into the music folder.'));
  for (const t of S.tracks) {
    const a = t.analysis;
    libBox.append(
      h(
        'div',
        { class: 'st-track' + (p.music?.trackId === t.id ? ' on' : '') },
        h('button', { class: 'st-play', title: playingTrack === t.id ? 'Stop' : 'Play', onclick: () => togglePlay(t) }, playingTrack === t.id ? '■' : '▶'),
        h(
          'div',
          { class: 'st-track-main' },
          h('div', { class: 'st-track-title' }, t.title, t.artist ? h('span', { class: 'muted' }, ` · ${t.artist}`) : null),
          h('div', { class: 'st-clip-sub' }, a ? `${Math.round(a.bpm)} BPM · ${fmtTime(a.durationSec)} · energy ${x100(a.energy)}${a.drops.length ? ` · drop ${fmtTime(a.drops[0])}` : ''}` : t.analysisError ? `Couldn't read: ${t.analysisError}` : 'Finding the beat…'),
          select({ value: t.license, options: LICENSES, onChange: async (v) => {
            upsertTrack(await api.music.update(t.id, { license: v }));
            refreshSuggestions();
          } }),
        ),
        h(
          'div',
          { class: 'st-track-actions' },
          p.music?.trackId === t.id ? h('span', { class: 'st-badge' }, 'In use') : h('button', { class: 'st-btn small', disabled: !a, onclick: () => useTrack(t) }, 'Use'),
          h('button', { class: 'st-x', title: 'Remove from library', onclick: async () => {
            if (!confirm(`Remove "${t.title}" from your music? The file in the music folder is deleted too.`)) return;
            await api.music.remove(t.id, true);
            S.tracks = S.tracks.filter((x) => x.id !== t.id);
            if (S.project.music?.trackId === t.id) change((pr) => (pr.music = null));
            refreshSuggestions();
            renderLeft();
          } }, '×'),
        ),
      ),
    );
  }
  blocks.push(libBox);
  return h('div', { class: 'st-panel' }, blocks);
}

function useTrack(t) {
  const sug = S.suggest?.ranked.find((s) => s.trackId === t.id);
  change((p) => (p.music = { trackId: t.id, file: t.file, title: t.title, start: 'auto' }), [renderLeft, renderCenter, renderRight]);
  if (sug?.warnings?.length) toast(root, sug.warnings[0], 'warn', 7000);
}

function togglePlay(t) {
  if (playingTrack === t.id) {
    audio.pause();
    playingTrack = null;
  } else {
    audio.src = fileUrl(t.file);
    const drop = t.analysis?.drops?.[0];
    audio.currentTime = drop ? Math.max(0, drop - 6) : 0;
    audio.play().catch((e) => toast(root, `Can't play it: ${e.message}`, 'error'));
    playingTrack = t.id;
  }
  renderLeft();
}

const refreshSuggestions = debounce(async () => {
  if (!S.project) return;
  try {
    S.suggest = await api.music.suggest(S.project);
  } catch {
    S.suggest = { ranked: [], sources: [], note: '' };
  }
  if (S.leftTab === 'music') renderLeft();
}, 300);

// ---------- centre: preview ----------

function renderCenter() {
  if (!E.center || !S.project) return;
  const f = fmt();
  const tl = S.timeline;
  const ar = f.width / f.height;
  const stage = h('div', { class: 'st-stage', style: { aspectRatio: `${f.width} / ${f.height}` } });
  if (S.preview) {
    const v = h('video', { class: 'st-preview', src: fileUrl(S.preview.file), controls: true, autoplay: S.preview.autoplay, playsInline: true });
    S.preview.autoplay = false;
    v.addEventListener('timeupdate', () => drawTL(v.currentTime));
    stage.append(v);
  } else {
    stage.append(
      h(
        'div',
        { class: 'st-stage-empty' },
        !S.project.clips.length
          ? [h('h3', {}, 'Start a reel'), h('p', {}, 'Add clips from the left. Pick music under Music. The studio lines up every kill with the beat for you.')]
          : [h('h3', {}, 'Ready to preview'), h('p', {}, 'Renders a quick, low-res version so you can watch the edit.'), h('button', { class: 'st-btn primary', disabled: !S.init.ffmpeg.ok, onclick: () => startRender({ preview: true }) }, 'Render preview')],
      ),
    );
  }
  if (S.safeZones && vertical()) {
    const s = f.safe;
    stage.append(
      h('div', { class: 'st-safe top', style: { height: pct(s.top) } }),
      h('div', { class: 'st-safe bottom', style: { height: pct(s.bottom) } }),
      h('div', { class: 'st-safe right', style: { width: pct(s.right), top: pct(s.top), bottom: pct(s.bottom) } }),
    );
  }
  const job = S.job;
  if (job && !['done', 'error', 'cancelled'].includes(job.stage)) {
    stage.append(
      h(
        'div',
        { class: 'st-progress' },
        h('div', { class: 'st-progress-msg' }, job.message || 'Working…'),
        h('div', { class: 'st-bar' }, h('div', { style: { width: pct(job.pct || 0) } })),
        h('button', { class: 'st-btn small ghost', onclick: () => api.cancel(job.jobId) }, 'Cancel'),
      ),
    );
  }

  const killsTotal = tl?.kills.length ?? 0;
  const onBeat = tl ? tl.clips.reduce((n, c) => n + c.onBeat.filter(Boolean).length, 0) : 0;
  const stale = S.preview && S.preview.key !== planKey();
  const info = h(
    'div',
    { class: 'st-info' },
    tl ? h('span', {}, `${fmtTime(tl.duration, true)} · ${S.project.clips.length} clip${S.project.clips.length === 1 ? '' : 's'} · ${killsTotal} kill${killsTotal === 1 ? '' : 's'}${S.project.music && S.project.style.beatSync ? ` · ${onBeat}/${killsTotal} on the beat` : ''}`) : null,
    tl && tl.duration > f.idealSeconds[1] && tl.duration <= f.maxSeconds ? h('span', { class: 'st-warn' }, ` · ${f.label} edits do best under ${f.idealSeconds[1]} s`) : null,
    stale ? h('span', { class: 'st-warn' }, ' · changed since this preview') : null,
    vertical() ? toggle({ label: 'Safe zones', checked: S.safeZones, onChange: (v) => ((S.safeZones = v), renderCenter()), hint: 'Shows where TikTok/Instagram/YouTube put their buttons and captions' }) : null,
  );
  const warn = tl?.warnings?.length ? h('ul', { class: 'st-warnings' }, tl.warnings.map((w) => h('li', {}, w))) : null;
  const done = job?.stage === 'done' && !job.preview && job.files?.length ? exportDone(job) : null;
  const err = job?.stage === 'error' ? h('div', { class: 'st-error' }, h('b', {}, 'Render failed. '), job.error || '') : null;
  const wrap = h('div', { class: 'st-stage-wrap' }, stage);
  wrap.style.setProperty('--ar', String(ar));
  clear(E.center, wrap, info, warn, err, done);
}

function exportDone(job) {
  const startAt = S.timeline?.musicStart ?? 0;
  return h(
    'div',
    { class: 'st-done' },
    h('b', {}, 'Exported. '),
    job.files.map((f) => h('div', {}, h('a', { href: '#', onclick: (e) => (e.preventDefault(), api.show(f)) }, f.split(/[\\/]/).pop()))),
    job.files.some((f) => f.includes('_nomusic')) && S.project.music ? h('p', { class: 'st-note' }, `For the no-music copy: add "${S.project.music.title}" in the app and set the sound to start at ${fmtTime(startAt, true)}.`) : null,
  );
}

// ---------- right: inspector ----------

function renderRight() {
  if (!E.right || !S.project) return;
  const tabs = [
    ['clip', 'Clip'],
    ['style', 'Style'],
    ['text', 'Text'],
    ['audio', 'Audio'],
  ];
  const body = S.rightTab === 'clip' ? clipInspector() : S.rightTab === 'style' ? stylePanel() : S.rightTab === 'text' ? textPanel() : audioPanel();
  clear(E.right, h('div', { class: 'st-tabs' }, tabs.map(([id, label]) => h('button', { class: S.rightTab === id ? 'on' : '', onclick: () => ((S.rightTab = id), renderRight()) }, label))), h('div', { class: 'st-panel' }, body));
}

function selectClip(uid) {
  S.sel = uid;
  S.rightTab = 'clip';
  renderRight();
  renderStrip();
  drawTL();
}

function clipInspector() {
  const c = clipByUid(S.sel);
  if (!c) return h('p', { class: 'st-empty' }, 'Click a clip in the strip below to trim it, move its kill markers, set the crop and switch its mic on or off.');
  const idx = S.project.clips.indexOf(c);
  const f = fmt();
  const v = h('video', { src: fileUrl(c.videoFile), controls: true, preload: 'auto', playsInline: true });
  const wrap = h('div', { class: 'st-src' }, v);
  const crop = h('div', { class: 'st-crop' });
  wrap.append(crop);
  const bar = h('div', { class: 'st-scrub' });
  const timeLbl = h('span', { class: 'st-val' }, '0:00.0');

  const placeCrop = () => {
    const vw = v.videoWidth || c.width || 16;
    const vh = v.videoHeight || c.height || 9;
    const box = wrap.getBoundingClientRect();
    const scale = Math.min(box.width / vw, box.height / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const ox = (box.width - dw) / 2;
    const oy = (box.height - dh) / 2;
    const ar = f.width / f.height;
    const z = c.cropZoom || 1;
    const cw = Math.min(1, (vh * ar) / vw) / z;
    const ch = Math.min(1, vw / ar / vh) / z;
    Object.assign(crop.style, {
      left: `${ox + (1 - cw) * c.cropX * dw}px`,
      top: `${oy + (1 - ch) * c.cropY * dh}px`,
      width: `${cw * dw}px`,
      height: `${ch * dh}px`,
      display: cw >= 0.999 && ch >= 0.999 ? 'none' : 'block',
    });
    crop._geom = { ox, oy, dw, dh, cw, ch };
  };
  v.addEventListener('loadedmetadata', () => {
    placeCrop();
    v.currentTime = Math.max(0, (c.hits[0] ?? c.in) - 1.5);
  });
  new ResizeObserver(placeCrop).observe(wrap);
  crop.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    crop.setPointerCapture(e.pointerId);
    const g = crop._geom;
    const startX = e.clientX;
    const startY = e.clientY;
    const cx0 = c.cropX;
    const cy0 = c.cropY;
    const move = (ev) => {
      const dx = (ev.clientX - startX) / (g.dw * (1 - g.cw) || 1);
      const dy = (ev.clientY - startY) / (g.dh * (1 - g.ch) || 1);
      c.cropX = Math.min(1, Math.max(0, cx0 + dx));
      c.cropY = Math.min(1, Math.max(0, cy0 + dy));
      placeCrop();
    };
    const up = () => {
      crop.removeEventListener('pointermove', move);
      change(() => undefined);
    };
    crop.addEventListener('pointermove', move);
    crop.addEventListener('pointerup', up, { once: true });
  });

  const drawBar = () => {
    clear(bar);
    const d = c.durationSec || 1;
    bar.append(h('div', { class: 'st-scrub-off', style: { left: 0, width: pct(c.in / d) } }), h('div', { class: 'st-scrub-off', style: { left: pct(c.out / d), right: 0 } }));
    c.hits.forEach((t, i) => bar.append(h('div', { class: 'st-scrub-kill', style: { left: pct(t / d) }, title: `Kill ${i + 1} at ${fmtTime(t, true)}` })));
    bar.append(h('div', { class: 'st-scrub-head', style: { left: pct((v.currentTime || 0) / d) } }));
  };
  v.addEventListener('timeupdate', () => {
    timeLbl.textContent = fmtTime(v.currentTime, true);
    const head = bar.querySelector('.st-scrub-head');
    if (head) head.style.left = pct(v.currentTime / (c.durationSec || 1));
  });
  bar.addEventListener('click', (e) => {
    const r = bar.getBoundingClientRect();
    v.currentTime = ((e.clientX - r.left) / r.width) * c.durationSec;
  });
  drawBar();

  const killList = h('div', { class: 'st-kills' });
  const drawKills = () => {
    clear(killList);
    if (!c.hits.length) killList.append(h('p', { class: 'st-note' }, 'No kill marked. Play to the moment and press Mark kill, so the studio can land it on a beat.'));
    c.hits.forEach((t, i) => {
      const nudge = (d) => change((p) => {
        const cl = p.clips.find((x) => x.uid === c.uid);
        cl.hits[i] = Math.max(0, Math.min(cl.durationSec, cl.hits[i] + d));
        cl.hits.sort((a, b) => a - b);
      }, [drawKills, drawBar]);
      killList.append(
        h(
          'div',
          { class: 'st-kill' },
          h('button', { class: 'st-link', onclick: () => ((v.currentTime = Math.max(0, t - 1)), v.play()) }, `Kill ${i + 1} · ${fmtTime(t, true)}`),
          h('button', { title: '0.1 s earlier', onclick: () => nudge(-0.1) }, '−0.1'),
          h('button', { title: '0.1 s later', onclick: () => nudge(0.1) }, '+0.1'),
          h('button', { class: 'st-x', title: 'Remove marker', onclick: () => change((p) => p.clips.find((x) => x.uid === c.uid).hits.splice(i, 1), [drawKills, drawBar]) }, '×'),
        ),
      );
    });
  };
  drawKills();

  const setNum = (key, val) => change((p) => {
    const cl = p.clips.find((x) => x.uid === c.uid);
    cl[key] = val;
  });
  return h(
    'div',
    { class: 'st-inspector' },
    h('div', { class: 'st-clip-title' }, `Clip ${idx + 1}: ${c.kills} kill${c.kills === 1 ? '' : 's'} · ${c.hero ?? 'Unknown'}`, c.map ? h('span', { class: 'muted' }, ` · ${c.map}`) : null),
    wrap,
    bar,
    h(
      'div',
      { class: 'st-row' },
      timeLbl,
      h('button', { class: 'st-btn small', onclick: () => change((p) => {
        const cl = p.clips.find((x) => x.uid === c.uid);
        cl.hits.push(v.currentTime);
        cl.hits.sort((a, b) => a - b);
      }, [drawKills, drawBar]) }, 'Mark kill'),
      h('button', { class: 'st-btn small ghost', title: 'Nothing before this point is used', onclick: () => (setNum('in', Math.min(v.currentTime, c.out - 0.5)), drawBar()) }, 'Start here'),
      h('button', { class: 'st-btn small ghost', title: 'Nothing after this point is used', onclick: () => (setNum('out', Math.max(v.currentTime, c.in + 0.5)), drawBar()) }, 'End here'),
    ),
    killList,
    vertical() || c.cropZoom > 1 ? h('p', { class: 'st-note' }, 'Drag the box on the video to choose what stays in frame.') : null,
    slider({ label: 'Punch in', min: 1, max: 2, step: 0.05, value: c.cropZoom, format: (z) => `${z.toFixed(2)}×`, onInput: (z) => {
      c.cropZoom = z;
      placeCrop();
      setNum('cropZoom', z);
    }, hint: 'Zooms into the middle of the crop, like the reference edits' }),
    c.hasMic
      ? toggle({ label: 'Use my mic in this clip', checked: c.useMic, onChange: (on) => setNum('useMic', on), hint: 'Your mic is on its own track, so it can be left out per clip' })
      : h('p', { class: 'st-note' }, 'This clip has no mic track.'),
    toggle({ label: 'Mute game sound', checked: !!c.muteGame, onChange: (on) => setNum('muteGame', on) }),
    toggle({ label: 'Land this clip on the drop', checked: S.project.heroUid === c.uid || (!S.project.heroUid && isTopScore(c)), onChange: (on) => change((p) => (p.heroUid = on ? c.uid : undefined)), hint: 'Its first kill hits the song\'s drop. By default that is your highest-scoring clip.' }),
    h(
      'div',
      { class: 'st-row' },
      h('button', { class: 'st-btn small ghost', disabled: idx === 0, onclick: () => moveClip(idx, -1) }, '← Earlier'),
      h('button', { class: 'st-btn small ghost', disabled: idx === S.project.clips.length - 1, onclick: () => moveClip(idx, 1) }, 'Later →'),
      h('button', { class: 'st-btn small danger', onclick: () => removeClip(c.uid) }, 'Remove'),
    ),
  );
}

function isTopScore(c) {
  return S.project.clips.every((x) => x.score <= c.score) && S.project.clips.findIndex((x) => x.score === c.score) === S.project.clips.indexOf(c);
}

function moveClip(i, d) {
  change((p) => {
    const j = i + d;
    if (j < 0 || j >= p.clips.length) return;
    const [c] = p.clips.splice(i, 1);
    p.clips.splice(j, 0, c);
    p.order = 'manual';
  }, [renderRight, renderStrip]);
}

function removeClip(uid) {
  change((p) => (p.clips = p.clips.filter((c) => c.uid !== uid)), [renderLeft, renderStrip]);
  if (S.sel === uid) {
    S.sel = null;
    renderRight();
  }
}

function stylePanel() {
  const p = S.project;
  const st = p.style;
  const set = (fn) => change((pr) => fn(pr.style), [renderCenter]);
  // Toggles and selects can show or hide other controls, so they redraw the panel. Sliders don't (it would drop the drag).
  const setR = (fn) => change((pr) => fn(pr.style), [renderCenter, renderRight]);
  const ai = S.init.ai.signedIn;
  const req = h('input', { placeholder: 'e.g. more shake, slower intro, no flashes', maxlength: 300 });
  const aiBox = h(
    'div',
    { class: 'st-ai' },
    h('div', { class: 'st-label' }, 'Change it in plain English'),
    h(
      'div',
      { class: 'st-row' },
      req,
      h('button', { class: 'st-btn small', disabled: !ai || S.busy.tweak, title: ai ? '' : 'Sign in under Settings, Account to use AI', onclick: () => {
        const text = req.value.trim();
        if (!text) return;
        guarded('tweak', async () => {
          const r = await api.ai.tweakStyle(p, text);
          S.styleUndo = JSON.parse(JSON.stringify(p.style));
          change((pr) => (pr.style = r.style));
          toast(root, r.summary);
        }, null);
      } }, S.busy.tweak ? 'Working…' : 'Apply'),
    ),
    S.styleUndo ? h('button', { class: 'st-link', onclick: () => (change((pr) => (pr.style = S.styleUndo)), (S.styleUndo = null), renderRight()) }, 'Undo AI change') : null,
  );
  req.addEventListener('keydown', (e) => e.key === 'Enter' && aiBox.querySelector('button').click());

  return [
    select({
      label: 'Edit style',
      value: st.id,
      options: S.init.styles.map((s) => [s.id, s.name]),
      onChange: (id) => {
        const base = S.init.styles.find((s) => s.id === id);
        change((pr) => {
          pr.style = JSON.parse(JSON.stringify(base));
          pr.mix = { ...base.mix };
        }, [renderRight, renderCenter, refreshSuggestions]);
      },
    }),
    h('p', { class: 'st-note' }, st.description),
    aiBox,
    h('h3', {}, 'Timing'),
    toggle({ label: 'Cut to the beat', checked: st.beatSync, onChange: (v) => setR((s) => (s.beatSync = v)), hint: 'Kills and cuts land on beats, and the best kill on the drop' }),
    select({ label: 'Clip order', value: p.order, options: [['manual', 'My order'], ['build-up', 'Build up (best last)']], onChange: (v) => change((pr) => (pr.order = v), [renderStrip]) }),
    slider({ label: 'Run-up before the first kill', min: 0.5, max: 6, step: 0.1, value: st.leadIn[1], format: (v) => `up to ${v.toFixed(1)} s`, onInput: (v) => set((s) => (s.leadIn = [Math.min(s.leadIn[0], v), v])) }),
    slider({ label: 'Speed-ups between kills', min: 1, max: 3, step: 0.05, value: st.speedRange[1], format: (v) => `up to ${v.toFixed(2)}×`, onInput: (v) => set((s) => {
      s.speedRange = [s.speedRange[0], v];
      s.cruiseSpeed = Math.min(s.cruiseSpeed, v);
    }) }),
    h('h3', {}, 'Slow-mo'),
    toggle({ label: 'Slow-mo on kills', checked: st.slowmo.on, onChange: (v) => setR((s) => (s.slowmo.on = v)) }),
    select({ label: 'Which kills', value: st.slowmo.scope, options: [['all', 'Every kill'], ['hero', 'Only the big moment']], onChange: (v) => setR((s) => (s.slowmo.scope = v)) }),
    slider({ label: 'Slow-mo speed', min: 0.2, max: 0.8, step: 0.05, value: st.slowmo.speed, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => set((s) => (s.slowmo.speed = v)) }),
    select({ label: 'Smoothing', value: st.slowmo.smooth, options: [['none', 'None (fastest)'], ['blend', 'Blend frames'], ['motion', 'Motion (smoothest, slow export)']], onChange: (v) => setR((s) => (s.slowmo.smooth = v)), hint: 'Record at 120 fps for the smoothest slow-mo' }),
    toggle({ label: 'Afterimage trails', checked: st.echo.on, onChange: (v) => setR((s) => (s.echo.on = v)), hint: 'The "Sandevistan" look' }),
    st.echo.on ? slider({ label: 'Trail strength', min: 0.1, max: 0.95, step: 0.05, value: st.echo.strength, format: x100, onInput: (v) => set((s) => (s.echo.strength = v)) }) : null,
    h('h3', {}, 'Hits'),
    toggle({ label: 'Zoom punch', checked: st.zoom.on, onChange: (v) => setR((s) => (s.zoom.on = v)) }),
    st.zoom.on ? slider({ label: 'Punch', min: 1.02, max: 1.4, step: 0.01, value: st.zoom.amount, format: (v) => `${Math.round((v - 1) * 100)}%`, onInput: (v) => set((s) => (s.zoom.amount = v)) }) : null,
    st.zoom.on ? select({ label: 'Pulse on the beat', value: st.zoom.onBeats, options: [['none', 'Off'], ['downbeats', 'Every bar'], ['all', 'Every beat']], onChange: (v) => setR((s) => (s.zoom.onBeats = v)) }) : null,
    toggle({ label: 'Shake', checked: st.shake.on, onChange: (v) => setR((s) => (s.shake.on = v)) }),
    st.shake.on ? slider({ label: 'Shake amount', min: 0.002, max: 0.03, step: 0.001, value: st.shake.amount, format: (v) => `${Math.round(v * 1000)}`, onInput: (v) => set((s) => (s.shake.amount = v)) }) : null,
    toggle({ label: 'Flash on kills', checked: st.flash.on && st.flash.onKills, onChange: (v) => setR((s) => {
      s.flash.onKills = v;
      if (v) s.flash.on = true;
    }) }),
    toggle({ label: 'Flash on the drop', checked: st.flash.on && st.flash.onDrop, onChange: (v) => setR((s) => {
      s.flash.onDrop = v;
      if (v) s.flash.on = true;
    }) }),
    st.flash.on ? slider({ label: 'Flash strength', min: 0.1, max: 1, step: 0.05, value: st.flash.strength, format: x100, onInput: (v) => set((s) => (s.flash.strength = v)) }) : null,
    toggle({ label: 'Colour split on kills', checked: st.rgbSplit.on, onChange: (v) => setR((s) => (s.rgbSplit.on = v)) }),
    toggle({ label: 'Motion blur on speed-ups', checked: st.motionBlur.on, onChange: (v) => setR((s) => (s.motionBlur.on = v)) }),
    h('h3', {}, 'Look'),
    select({ label: 'Between clips', value: st.transition, options: [['cut', 'Hard cut'], ['flash', 'White flash'], ['dip', 'Dip to black'], ['whip', 'Whip (zoom + shake)']], onChange: (v) => setR((s) => (s.transition = v)) }),
    slider({ label: 'Contrast', min: 0.8, max: 1.4, step: 0.01, value: st.grade.contrast, format: (v) => v.toFixed(2), onInput: (v) => set((s) => (s.grade.contrast = v)) }),
    slider({ label: 'Saturation', min: 0.5, max: 1.6, step: 0.01, value: st.grade.saturation, format: (v) => v.toFixed(2), onInput: (v) => set((s) => (s.grade.saturation = v)) }),
    slider({ label: 'Vignette', min: 0, max: 1, step: 0.05, value: st.grade.vignette, format: x100, onInput: (v) => set((s) => (s.grade.vignette = v)) }),
    slider({ label: 'Fade out at the end', min: 0, max: 3, step: 0.1, value: st.fadeOut, format: (v) => `${v.toFixed(1)} s`, onInput: (v) => set((s) => (s.fadeOut = v)) }),
  ];
}

function textPanel() {
  const p = S.project;
  const st = p.style;
  const ai = S.init.ai.signedIn;
  const area = h('textarea', {
    rows: 7,
    placeholder: 'One line per caption, e.g.\nThey said Deadpool was a support\nThey were wrong',
    value: p.captions.map((c) => c.text).join('\n'),
    oninput: (e) => change((pr) => (pr.captions = e.target.value.split('\n').map((text) => ({ text })).filter((c, i, arr) => c.text.trim() || i < arr.length - 1))),
  });
  const idea = h('input', { placeholder: 'Idea for the AI (optional)', maxlength: 300 });
  const post = h('textarea', { rows: 3, placeholder: 'Post caption and hashtags', value: p.caption ?? '', oninput: (e) => change((pr) => (pr.caption = e.target.value)) });
  const intro = p.intro;
  return [
    h('h3', {}, 'Hook card'),
    toggle({ label: 'Open with a hook card', checked: !!intro, onChange: (on) => change((pr) => (pr.intro = on ? { text: '', seconds: 4 } : null), [renderRight]), hint: 'An image with big text before the gameplay. The cut into gameplay lands on the drop.' }),
    intro
      ? [
          h('label', { class: 'st-field' }, h('span', { class: 'st-label' }, 'Headline'), h('input', { value: intro.text, maxlength: 120, placeholder: 'e.g. Rate this Deadpool 1-10', oninput: (e) => change((pr) => (pr.intro.text = e.target.value)) })),
          h(
            'div',
            { class: 'st-row' },
            h('button', { class: 'st-btn small', onclick: async () => {
              const img = await api.pickImage();
              if (img) change((pr) => (pr.intro.image = img), [renderRight]);
            } }, intro.image ? 'Change image' : 'Pick image'),
            intro.image ? h('span', { class: 'st-note' }, intro.image.split(/[\\/]/).pop()) : h('span', { class: 'st-note' }, 'No image: uses a blurred frame of your first clip'),
            intro.image ? h('button', { class: 'st-x', onclick: () => change((pr) => delete pr.intro.image, [renderRight]) }, '×') : null,
          ),
          slider({ label: 'Length', min: 1, max: 12, step: 0.5, value: intro.seconds, format: (v) => `about ${v} s`, onInput: (v) => change((pr) => (pr.intro.seconds = v)), hint: 'Snaps to the beat, ideally ending on the drop' }),
        ]
      : null,
    h('h3', {}, 'Captions'),
    area,
    h(
      'div',
      { class: 'st-row' },
      idea,
      h('button', { class: 'st-btn small', disabled: !ai || S.busy.caps, title: ai ? '' : 'Sign in under Settings, Account to use AI', onclick: () => guarded('caps', async () => {
        const lines = await api.ai.captions(p, idea.value, Math.max(4, Math.min(12, Math.round((S.timeline?.duration ?? 20) / 3))));
        change((pr) => (pr.captions = lines.map((text) => ({ text }))), [renderRight]);
      }, null) }, S.busy.caps ? 'Writing…' : 'Write with AI'),
    ),
    select({ label: 'Position', value: st.captions.position, options: [['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']], onChange: (v) => change((pr) => (pr.style.captions.position = v)) }),
    slider({ label: 'Size', min: 0.035, max: 0.11, step: 0.005, value: st.captions.size, format: (v) => `${Math.round(v * 1000)}`, onInput: (v) => change((pr) => (pr.style.captions.size = v)) }),
    slider({ label: 'Beats per line', min: 1, max: 16, step: 1, value: st.captions.beatsPerLine, format: (v) => `${v}`, onInput: (v) => change((pr) => (pr.style.captions.beatsPerLine = v)) }),
    toggle({ label: 'ALL CAPS', checked: st.captions.uppercase, onChange: (v) => change((pr) => (pr.style.captions.uppercase = v)) }),
    h('h3', {}, 'Post caption'),
    post,
    h(
      'div',
      { class: 'st-row' },
      h('button', { class: 'st-btn small', disabled: !ai || S.busy.post, onclick: () => guarded('post', async () => {
        const c = await api.ai.postCaption(p);
        change((pr) => (pr.caption = c), [renderRight]);
      }, null) }, S.busy.post ? 'Writing…' : 'Write with AI'),
      h('button', { class: 'st-btn small ghost', onclick: () => navigator.clipboard.writeText(post.value).then(() => toast(root, 'Copied')) }, 'Copy'),
    ),
  ];
}

function audioPanel() {
  const p = S.project;
  const m = p.mix;
  const set = (fn) => change((pr) => fn(pr.mix));
  const t = currentTrack();
  const micClips = p.clips.filter((c) => c.hasMic);
  return [
    h('h3', {}, 'Mix'),
    slider({ label: 'Game', min: 0, max: 1.5, step: 0.05, value: m.game, format: x100, onInput: (v) => set((x) => (x.game = v)) }),
    slider({ label: 'Mic', min: 0, max: 2, step: 0.05, value: m.mic, format: x100, onInput: (v) => set((x) => (x.mic = v)) }),
    slider({ label: 'Music', min: 0, max: 1.5, step: 0.05, value: m.music, format: x100, onInput: (v) => set((x) => (x.music = v)) }),
    toggle({ label: 'Lower the music while I talk', checked: m.duck, onChange: (v) => set((x) => (x.duck = v)) }),
    slider({ label: 'Impact sound on kills', min: 0, max: 1, step: 0.05, value: p.style.impactSound, format: x100, onInput: (v) => change((pr) => (pr.style.impactSound = v)) }),
    slider({ label: 'Game volume in slow-mo', min: 0, max: 1, step: 0.05, value: p.style.slowmo.gameVolume, format: x100, onInput: (v) => change((pr) => (pr.style.slowmo.gameVolume = v)) }),
    h('h3', {}, 'Song start'),
    p.music && t?.analysis
      ? [
          toggle({ label: 'Pick automatically (best kill on the drop)', checked: p.music.start === 'auto', onChange: (on) => change((pr) => (pr.music.start = on ? 'auto' : S.timeline?.musicStart ?? 0), [renderRight]) }),
          p.music.start !== 'auto'
            ? slider({ label: 'Starts at', min: 0, max: Math.max(1, t.analysis.durationSec - 5), step: 0.05, value: p.music.start, format: (v) => fmtTime(v, true), onInput: (v) => change((pr) => (pr.music.start = v)) })
            : h('p', { class: 'st-note' }, `Starts at ${fmtTime(S.timeline?.musicStart ?? 0, true)}.`),
        ]
      : h('p', { class: 'st-note' }, 'Pick a song under Music on the left.'),
    h('h3', {}, 'Mic per clip'),
    micClips.length
      ? micClips.map((c) => toggle({ label: `Clip ${p.clips.indexOf(c) + 1} · ${c.hero ?? ''} ${c.kills}k`, checked: c.useMic, onChange: (on) => change((pr) => (pr.clips.find((x) => x.uid === c.uid).useMic = on), [renderStrip]) }))
      : h('p', { class: 'st-note' }, 'None of these clips has a mic track. Turn on "Record my mic" in Settings to get one.'),
  ];
}

// ---------- bottom: strip ----------

function renderStrip() {
  if (!E.strip || !S.project) return;
  const tl = S.timeline;
  const chips = S.project.clips.map((c, i) => {
    const tc = tl?.clips.find((x) => x.uid === c.uid);
    const chip = h(
      'div',
      {
        class: 'st-chip' + (S.sel === c.uid ? ' on' : ''),
        draggable: true,
        style: { borderColor: `hsl(${clipHue(i)} 55% 45%)` },
        onclick: () => selectClip(c.uid),
        ondragstart: (e) => e.dataTransfer.setData('text/plain', String(i)),
        ondragover: (e) => e.preventDefault(),
        ondrop: (e) => {
          e.preventDefault();
          const from = Number(e.dataTransfer.getData('text/plain'));
          if (Number.isFinite(from) && from !== i) {
            change((p) => {
              const [m] = p.clips.splice(from, 1);
              p.clips.splice(i, 0, m);
              p.order = 'manual';
            }, [renderStrip, renderRight]);
          }
        },
      },
      h('span', { class: 'st-chip-n' }, i + 1),
      h('span', {}, `${c.hero ?? 'Clip'} · ${c.kills}k`),
      tc ? h('span', { class: 'muted' }, ` ${(tc.out[1] - tc.out[0]).toFixed(1)}s`) : null,
      c.hasMic
        ? h('button', { class: 'st-mic' + (c.useMic ? ' on' : ''), title: c.useMic ? 'Mic on in this clip (click to turn off)' : 'Mic off in this clip (click to turn on)', onclick: (e) => {
            e.stopPropagation();
            change((p) => (p.clips[i].useMic = !p.clips[i].useMic), [renderStrip, renderRight]);
          } }, c.useMic ? 'mic on' : 'mic off')
        : null,
      h('button', { class: 'st-x', title: 'Remove', onclick: (e) => (e.stopPropagation(), removeClip(c.uid)) }, '×'),
    );
    return chip;
  });
  clear(E.strip, chips.length ? chips : h('span', { class: 'st-note' }, 'Your reel\'s clips appear here. Drag to reorder.'));
}

function drawTL(playhead) {
  if (!E.canvas || !S.project) return;
  hit = drawTimeline(E.canvas, { timeline: S.timeline, track: currentTrack(), selectedUid: S.sel, playhead: Number.isFinite(playhead) ? playhead : undefined });
}

// ---------- rendering ----------

async function startRender(req) {
  saveSoon.flush(S.project);
  const request = { preview: !!req.preview, formats: req.formats ?? [S.project.format], noMusicCopy: !!req.noMusicCopy, gpu: !!req.gpu };
  try {
    const { jobId } = await api.render(S.project, request);
    S.job = { jobId, stage: 'clips', pct: 0, message: 'Starting…', preview: request.preview, key: planKey() };
  } catch (err) {
    toast(root, err.message, 'error', 7000);
  }
  renderTop();
  renderCenter();
}

function onProgress(p) {
  if (!S.job || p.jobId !== S.job.jobId) return;
  Object.assign(S.job, p);
  if (p.stage === 'done') {
    if (S.job.preview && p.files?.[0]) S.preview = { file: p.files[0], key: S.job.key, autoplay: true };
    else {
      S.project.lastExports = [...(S.project.lastExports ?? []), ...(p.files ?? []).map((f) => ({ file: f, format: S.project.format, at: Date.now() }))];
      toast(root, 'Export finished');
    }
    renderTop();
  }
  if (p.stage === 'error' || p.stage === 'cancelled') renderTop();
  renderCenter();
}

function openExport() {
  const p = S.project;
  const t = currentTrack();
  const chosen = new Set([p.format]);
  const gpuOk = S.init.ffmpeg.gpuEncoders.length > 0;
  let noMusic = !!p.music && fmt().music.inAppLibrary;
  let gpu = false;
  const close = () => modal.remove();
  const rows = S.init.formats.map((f) => {
    const warn = p.music && t && !['own', 'royalty-free'].includes(t.license) && f.platform === 'YouTube';
    return h(
      'label',
      { class: 'st-toggle' },
      h('input', { type: 'checkbox', checked: chosen.has(f.id), onchange: (e) => (e.target.checked ? chosen.add(f.id) : chosen.delete(f.id)) }),
      h('span', {}, `${f.label} `, h('span', { class: 'muted' }, `${f.width}×${f.height} · ${f.id === p.format ? p.fps : f.fps} fps`), warn ? h('span', { class: 'st-warn' }, ' · song may get claimed') : null),
    );
  });
  const modal = h(
    'div',
    { class: 'st-modal', onclick: (e) => e.target === modal && close() },
    h(
      'div',
      { class: 'st-dialog' },
      h('h2', {}, 'Export'),
      h('p', { class: 'st-note' }, `Saved to ${S.init.paths.reels}`),
      rows,
      h('hr'),
      p.music ? toggle({ label: 'Also save a copy without music', checked: noMusic, onChange: (v) => (noMusic = v), hint: 'Add the same song in TikTok or Instagram for full reach and no mute' }) : null,
      fmt().fpsOptions.length > 1
        ? select({ label: `Frame rate for ${fmt().label}`, value: p.fps, options: fmt().fpsOptions.map((x) => [x, `${x} fps`]), onChange: (v) => change((pr) => (pr.fps = Number(v))) })
        : null,
      toggle({ label: gpuOk ? `Faster export on the graphics card (${S.init.ffmpeg.gpuEncoders[0].replace('h264_', '').toUpperCase()})` : 'Faster export on the graphics card (not available)', checked: gpu, disabled: !gpuOk, onChange: (v) => (gpu = v) }),
      h(
        'div',
        { class: 'st-row end' },
        h('button', { class: 'st-btn ghost', onclick: close }, 'Cancel'),
        h('button', { class: 'st-btn primary', onclick: () => {
          if (!chosen.size) return;
          close();
          startRender({ preview: false, formats: [...chosen], noMusicCopy: noMusic, gpu });
        } }, 'Export'),
      ),
    ),
  );
  root.append(modal);
}

function onKey(e) {
  if (!root?.isConnected || root.closest('.hidden')) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag)) return;
  if (e.code === 'Space') {
    const v = E.center?.querySelector('video.st-preview');
    if (v) {
      e.preventDefault();
      v.paused ? v.play() : v.pause();
    }
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) removeClip(S.sel);
}
