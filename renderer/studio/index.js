// The Editing Studio. Mounted by the shell into #studio-root (see docs/studio-interface.md).
// State lives here; the main process plans, renders and stores everything (studio:* channels).

import { api } from './api.js';
import { clear, debounce, fileUrl, fmtTime, h, select, slider, toast, toggle } from './dom.js';
import { TIMELINE_HEIGHT, clipHue, drawTimeline } from './timeline.js';
import { PLATFORM_OF_FORMAT, formatOfFile, openAccounts, openFreeSearch, platformLabel, uploadRequest } from './share.js';

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
  filters: { q: '', minKills: 0, sort: 'score', hero: '', map: '', gameType: '', minRating: 0 },
  /** Clip ids that match the filters, in order, from the Library index. null until the first answer. */
  clipView: null,
  facets: null,
  busy: {},
  safeZones: true,
  styleUndo: null,
  publish: [],
  uploads: [],
  ideas: null,
  ideaRequest: '',
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
const planKey = () => JSON.stringify(S.project?.clips?.map(c => [c.uid,c.in,c.out,c.cropX,c.cropY,c.cropZoom,c.followCharacter,c.preserveKillFeed])) + JSON.stringify(S.timeline?.segments?.map((s) => [s.src, s.out]) ?? []) + JSON.stringify(S.project?.style) + JSON.stringify(S.project?.mix) + (S.project?.music?.file ?? '') + JSON.stringify(S.project?.captions) + JSON.stringify(S.project?.intro) + JSON.stringify(S.project?.outro ?? null);
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
// ---------- undo / redo ----------
// Every edit goes through change(), which keeps a copy of the reel before it.
// Quick bursts (dragging a slider, typing, dragging on the timeline) become one step.
const UNDO_LIMIT = 100;
const MERGE_MS = 700;
const hist = { projectId: null, past: [], future: [], lastAt: 0 };

function resetHistory() {
  hist.projectId = S.project?.id ?? null;
  hist.past = [];
  hist.future = [];
  hist.lastAt = 0;
  undoButtons();
}

function undoButtons() {
  if (E.undoBtn) E.undoBtn.disabled = !hist.past.length;
  if (E.redoBtn) E.redoBtn.disabled = !hist.future.length;
}

function recordUndo() {
  if (hist.projectId !== S.project.id) resetHistory();
  const now = Date.now();
  if (now - hist.lastAt > MERGE_MS || !hist.past.length) {
    hist.past.push(structuredClone(S.project));
    if (hist.past.length > UNDO_LIMIT) hist.past.shift();
  }
  hist.future = [];
  hist.lastAt = now;
  undoButtons();
}

function restore(snapshot) {
  S.project = snapshot;
  const entry = S.projects.find((x) => x.id === snapshot.id);
  if (entry) Object.assign(entry, { name: snapshot.name, clips: snapshot.clips.length });
  if (S.sel && !snapshot.clips.some((c) => c.uid === S.sel)) S.sel = null;
  S.preview = null;
  saveSoon(S.project);
  planSoon.flush();
  renderAll();
  undoButtons();
}

function undo() {
  if (hist.projectId !== S.project?.id || !hist.past.length) return;
  hist.future.push(structuredClone(S.project));
  hist.lastAt = 0;
  restore(hist.past.pop());
  toast(root, 'Undone', 'info', 1200);
}

function redo() {
  if (hist.projectId !== S.project?.id || !hist.future.length) return;
  hist.past.push(structuredClone(S.project));
  hist.lastAt = 0;
  restore(hist.future.pop());
  toast(root, 'Redone', 'info', 1200);
}

function change(fn, parts = []) {
  recordUndo();
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
  resetHistory();
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
    refreshClipView();
  } catch (err) {
    clear(root, h('div', { class: 'st-loading error' }, `The studio couldn't start: ${err.message}`));
    return;
  }
  build();
  api.on('studio:render:progress', onProgress);
  api.on('studio:publish:progress', onUploadProgress);
  S.publish = await api.publish.status().catch(() => []);
  api.on('studio:music:progress', (m) => toast(root, m.message));
  api.on('studio:music:updated', (t) => {
    upsertTrack(t);
    renderLeft();
    drawTL();
  });
  window.clipper?.onClip?.(async () => {
    S.library = await api.clips().catch(() => S.library);
    S.facets = null;
    refreshClipView();
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
      (E.undoBtn = h('button', { title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', disabled: !hist.past.length, onclick: undo }, 'Undo')),
      (E.redoBtn = h('button', { title: 'Redo (Ctrl+Shift+Z or Ctrl+Y)', 'aria-label': 'Redo', disabled: !hist.future.length, onclick: redo }, 'Redo')),
      // Uploads are optional and parked for now: the button shows once an account has keys.
      S.publish.some((x) => x.configured)
        ? h('button', { title: 'Connect YouTube, TikTok and Instagram for uploading', onclick: () => openAccounts(root, S, () => (renderTop(), renderCenter())) }, `Accounts${S.publish.some((x) => x.connected) ? ` (${S.publish.filter((x) => x.connected).length})` : ''}`)
        : null,
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
    [['ideas', 'Ideas'], ['clips', `Clips (${S.library.length})`], ['music', `Music (${S.tracks.length})`]].map(([id, label]) =>
      h('button', { class: S.leftTab === id ? 'on' : '', onclick: () => ((S.leftTab = id), renderLeft()) }, label),
    ),
  );
  clear(E.left, tabs, S.leftTab === 'clips' ? clipsPanel() : S.leftTab === 'ideas' ? ideasPanel() : musicPanel());
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

let clipQuerySeq = 0;
/** Ask the Library index for the clips that match the filters, then redraw the list. */
async function refreshClipView() {
  const f = S.filters;
  const seq = ++clipQuerySeq;
  try {
    const [view, facets] = await Promise.all([
      api.clipQuery({ text: f.q, hero: f.hero, map: f.map, gameType: f.gameType, minKills: f.minKills, minRating: f.minRating, sort: f.sort }),
      S.facets ? Promise.resolve(S.facets) : api.clipFacets(),
    ]);
    if (seq !== clipQuerySeq) return; // a newer query is on its way
    S.clipView = view;
    S.facets = facets;
  } catch {
    S.clipView = null; // fall back to filtering here
  }
  if (S.leftTab === 'clips') {
    const focused = document.activeElement?.matches?.('.st-filters input[type=search]');
    renderLeft();
    if (focused) focusSearch();
  }
}

function filteredClips() {
  const f = S.filters;
  if (S.clipView) {
    const byId = new Map(S.library.map((c) => [c.id, c]));
    return S.clipView.ids.map((id) => byId.get(id)).filter(Boolean);
  }
  const q = f.q.trim().toLowerCase();
  return S.library
    .filter((c) => c.reel.kills >= f.minKills && (!q || [c.hero, c.match?.map, ...(c.tags || [])].filter(Boolean).join(' ').toLowerCase().includes(q)))
    .sort((a, b) => (f.sort === 'new' ? b.createdAt - a.createdAt : f.sort === 'kills' ? b.reel.kills - a.reel.kills || b.score - a.score : b.score - a.score));
}

function clipsPanel() {
  const f = S.filters;
  const list = filteredClips();
  const inReel = new Map();
  for (const c of S.project.clips) inReel.set(c.videoFile, (inReel.get(c.videoFile) ?? 0) + 1);
  const ai = S.init.ai.signedIn;
  const target = fmt().idealSeconds[1];
  const setFilter = (k, v) => {
    f[k] = v;
    refreshClipView();
  };
  const facet = (key, all, items) =>
    select({ value: f[key], options: [['', all], ...(items ?? []).map((x) => [x.value, `${x.value} (${x.count})`])], onChange: (v) => setFilter(key, v) });
  const active = ['hero', 'map', 'gameType'].some((k) => f[k]) || f.minKills || f.minRating || f.q;

  const controls = h(
    'div',
    { class: 'st-filters' },
    h('input', { type: 'search', placeholder: 'Search hero, map, tag', title: 'Search by hero, map, mode, tag or who you eliminated', value: f.q, oninput: debounce((e) => setFilter('q', e.target.value), 200) }),
    facet('hero', 'Any hero', S.facets?.heroes),
    facet('map', 'Any map', S.facets?.maps),
    facet('gameType', 'Any mode', S.facets?.gameTypes),
    select({ value: f.minKills, options: [[0, 'Any kills'], [2, '2+ kills'], [3, '3+ kills'], [4, '4+ kills'], [6, 'Team wipe']], onChange: (v) => setFilter('minKills', Number(v)) }),
    select({ value: f.minRating, options: [[0, 'Any rating'], [3, '3★ and up'], [4, '4★ and up'], [5, '5★ only']], onChange: (v) => setFilter('minRating', Number(v)) }),
    select({ value: f.sort, options: [['score', 'Best'], ['kills', 'Most kills'], ['rating', 'Top rated'], ['new', 'Newest']], onChange: (v) => setFilter('sort', v) }),
    active
      ? h('button', { class: 'st-link', onclick: () => {
          Object.assign(f, { q: '', hero: '', map: '', gameType: '', minKills: 0, minRating: 0 });
          refreshClipView();
        } }, `Clear filters (${list.length} of ${S.library.length})`)
      : null,
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
        change((p) => p.clips.push({ ...structuredClone(c.reel), uid: Math.random().toString(36).slice(2, 10) }), [renderLeft, renderStrip]);
      } }, '+'),
    );
    grid.append(card);
  }
  return h('div', { class: 'st-panel' }, controls, actions, grid);
}

// ---------- ideas ----------

async function makeReel() {
  if (S.busy['make-reel'] || (S.job && !['done','error','cancelled'].includes(S.job.stage))) return;
  if (!S.ideaRequest?.trim()) return toast(root, 'Describe the reel first.', 'error');
  const prompt = S.ideaRequest;
  const format = fmt().id;
  S.busy['make-reel'] = true;
  const step = (name, detail) => { S.creation = { step: name, detail }; renderLeft(); };
  try {
    step('Planning your reel', 'ChatGPT or Claude is reading your prompt and selecting clips. This can take up to three minutes.');
    const ideas = await api.ideas.ai(format, prompt);
    if (!ideas?.length) throw new Error('No usable plan was returned. Your prompt is saved so you can try again.');
    S.ideas = ideas;
    const idea = ideas[0];
    step('Building the timeline', idea.concept || idea.title);
    saveSoon.flush(S.project);
    const project = await api.ideas.apply(idea);
    S.projects.unshift({id: project.id, name: project.name, updatedAt: project.updatedAt, clips: project.clips.length});
    await openProject(project.id);
    S.leftTab = 'ideas';
    if ((idea.music?.search || /music|song|rasputin/i.test(prompt)) && !S.project.music) {
      step('Choose music to continue', 'The timeline is ready. Import or select your song under Music, then press Preview.');
      return;
    }
    if (/jujutsu|jjk|overlay.{0,30}(picture|image|magik)/i.test(prompt)) {
      step('Timeline ready — requested effects need attention', 'External video intros, layered character images and a separate kill-feed overlay are still being built. Review the plan and available assets before using Preview.');
      return;
    }
    step('Rendering your preview', 'Clips are being timed to the available music and rendered. Follow the render progress in the preview.');
    await startRender({preview: true});
    if (S.job?.stage === 'error') throw new Error(S.job.error || S.job.message);
  } catch (error) {
    S.creation = {step: 'Reel needs attention', error: error.message};
  } finally {
    S.busy['make-reel'] = false;
    renderLeft(); renderTop();
  }
}

function ideasPanel() {
  const f = fmt();
  const ai = S.init.ai.signedIn;
  S.ideaRequest ||= localStorage.getItem('reel-prompt') || '';
  const working = !!S.busy['make-reel'];
  const req = h('textarea', { class: 'st-reel-prompt', rows: 9, placeholder: 'Describe the reel you want. Include the hero, length, music, intro and editing style…', maxlength: 20000, value: S.ideaRequest, disabled: working, oninput: (e) => {
    S.ideaRequest = e.target.value;
    localStorage.setItem('reel-prompt', S.ideaRequest);
  } });
  const status = S.creation;
  const getAi = () => guarded('ideas-ai', async () => {
    S.ideas = await api.ideas.ai(f.id, S.ideaRequest);
  }, null);
  req.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && ai && !working) {
      e.preventDefault(); void makeReel();
    }
  });
  const head = [
    h('label', { class: 'st-label' }, 'Describe your reel'),
    req,
    h('p', { class: 'st-note' }, 'Uses your saved clips and imported music. Add external footage or artwork before including it in an edit.'),
    h('div', { class: 'st-row' },
      h('button', { class: 'st-btn primary', disabled: !ai || working || !S.library.length || (S.job && !['done','error','cancelled'].includes(S.job.stage)), onclick: makeReel }, working ? 'Making reel…' : 'Make reel'),
      h('button', { class: 'st-btn small', disabled: working || !ai || S.busy['ideas-ai'], onclick: getAi }, 'Suggest ideas'),
      h('button', { class: 'st-btn small', disabled: working || S.busy['ideas-quick'], onclick: () => guarded('ideas-quick', async () => (S.ideas = await api.ideas.quick(f.id)), null) }, 'Quick ideas'),
    ),
    status ? h('div', { class: 'st-creation', role: 'status', 'aria-live': 'polite' },
      h('strong', {}, status.step),
      status.detail ? h('p', { class: 'st-note' }, status.detail) : null,
      status.error ? h('p', { class: 'st-error' }, status.error) : null,
    ) : null,
  ];
  const list = h('div', { class: 'st-ideas' });
  if (!S.library.length) list.append(h('p', { class: 'st-empty' }, 'Record some clips first. Ideas are built from your own plays.'));
  else if (!S.ideas) list.append(h('p', { class: 'st-empty' }, ai ? 'Press Get AI ideas, or Quick ideas for instant ones.' : 'Press Quick ideas. Sign in with Claude or ChatGPT (Settings) for more creative AI ideas.'));
  else if (!S.ideas.length) list.append(h('p', { class: 'st-empty' }, 'No ideas from these clips yet. Clips with kills work best.'));
  for (const idea of S.ideas ?? []) list.append(ideaCard(idea));
  return h('div', { class: 'st-panel' }, head, list);
}

function ideaCard(idea) {
  const styleName = S.init.styles.find((x) => x.id === idea.styleId)?.name ?? idea.styleId;
  const track = idea.music.trackId ? trackOf(idea.music.trackId) : null;
  const heroes = [...new Set(idea.clipIds.map((id) => S.library.find((c) => c.id === id)?.hero).filter(Boolean))];
  const redraw = () => renderLeft();
  return h(
    'div',
    { class: 'st-idea-card' },
    h('div', { class: 'st-row' }, h('div', { class: 'st-track-title' }, idea.title), h('div', { class: 'st-spacer' }), h('span', { class: 'st-tagpill' }, idea.source === 'ai' ? 'AI' : 'Quick')),
    idea.concept ? h('p', { class: 'st-idea-concept' }, idea.concept) : null,
    idea.hook ? h('div', { class: 'st-idea-hook' }, idea.hook) : null,
    idea.endText ? h('div', { class: 'st-clip-sub st-wrap' }, `Ends with: “${idea.endText}”`) : null,
    idea.captions.length ? h('div', { class: 'st-clip-sub st-wrap' }, idea.captions.slice(0, 4).map((c) => `“${c}”`).join(' → ') + (idea.captions.length > 4 ? ' …' : '')) : null,
    h('div', { class: 'st-clip-sub st-wrap' }, `${idea.clipIds.length} clip${idea.clipIds.length === 1 ? '' : 's'}${heroes.length ? ' · ' + heroes.slice(0, 3).join(', ') : ''} · ${styleName}`),
    h(
      'div',
      { class: 'st-idea-row' },
      h('span', { class: 'st-label' }, 'Music'),
      h('span', { class: 'st-wrap' }, track ? `${track.title}${track.analysis ? ` · ${Math.round(track.analysis.bpm)} BPM` : ''}` : [idea.music.mood, idea.music.bpm ? `${idea.music.bpm[0]}–${idea.music.bpm[1]} BPM` : null].filter(Boolean).join(' · ') || 'Any'),
      h('button', { class: 'st-link', onclick: () => openFreeSearch(root, { kind: 'audio', query: idea.music.search, onPick: (t) => {
        upsertTrack(t);
        idea.music.trackId = t.id;
        toast(root, `Added "${t.title}" to your music`);
        redraw();
      } }) }, track ? 'Change' : 'Find music'),
    ),
    idea.hook
      ? h(
          'div',
          { class: 'st-idea-row' },
          h('span', { class: 'st-label' }, 'Picture'),
          idea.image ? h('img', { class: 'st-idea-thumb', src: fileUrl(idea.image.file), alt: '' }) : h('span', { class: 'st-wrap muted' }, idea.imageIdea || 'Blurred frame of the first clip'),
          h('button', { class: 'st-link', onclick: () => openFreeSearch(root, { kind: 'image', query: idea.imageSearch || idea.imageIdea, onPick: (img) => {
            idea.image = img;
            redraw();
          } }) }, idea.image ? 'Change' : 'Find picture'),
        )
      : null,
    idea.why ? h('p', { class: 'st-note' }, idea.why) : null,
    h('button', { class: 'st-btn small primary', disabled: S.busy['apply-' + idea.id], onclick: () => guarded('apply-' + idea.id, async () => {
      if (saveSoon.pending()) saveSoon.flush();
      let proj = await api.ideas.apply(idea);
      if (idea.image && proj.intro) {
        proj.intro.image = idea.image.file;
        proj.intro.imageCredit = idea.image.credit || undefined;
        proj = await api.projects.save(proj);
      }
      S.projects.unshift({ id: proj.id, name: proj.name, updatedAt: proj.updatedAt, clips: proj.clips.length });
      await openProject(proj.id);
      S.leftTab = 'clips';
      S.rightTab = 'text';
      renderAll();
    }, `Made "${idea.title}". Check the captions, then press Preview.`) }, S.busy['apply-' + idea.id] ? 'Making it…' : 'Make this reel'),
  );
}

/** Credit lines the licences of the song and hook picture ask for. */
function creditsFor(p) {
  const parts = [];
  const t = p.music ? trackOf(p.music.trackId) : null;
  if (t?.credit) parts.push(`Music: ${t.credit}`);
  if (p.intro?.imageCredit) parts.push(`Picture: ${p.intro.imageCredit}`);
  return parts.join('\n');
}

/** Credit lines that aren't in the post caption yet. */
function missingCredits(p) {
  return creditsFor(p).split('\n').filter((line) => line && !(p.caption ?? '').includes(line)).join('\n');
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
      h('button', { class: 'st-btn small', title: 'Search Creative Commons songs you can use in videos', onclick: () => openFreeSearch(root, { kind: 'audio', query: 'phonk', onPick: (t) => {
        upsertTrack(t);
        refreshSuggestions();
        if (!S.project.music) useTrack(t);
        toast(root, `Added "${t.title}"${t.credit ? '. Its credit goes in your post caption' : ''}`);
        renderLeft();
      } }) }, 'Find free music'),
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
          t.credit ? h('div', { class: 'st-clip-sub st-wrap', title: 'Put this in your post caption' }, `Credit: ${t.credit}`) : null,
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
    v.muted = false;
    v.volume = 1;
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
        h('button', { class: 'st-btn small ghost', disabled: !job.jobId, onclick: () => api.cancel(job.jobId) }, 'Cancel'),
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
  const done = job?.stage === 'done' && !job.preview && job.files?.length && job.projectId === S.project.id ? exportDone(job) : null;
  const err = job?.stage === 'error' ? h('div', { class: 'st-error' }, h('b', {}, 'Render failed. '), job.error || '') : null;
  const wrap = h('div', { class: 'st-stage-wrap' }, stage);
  wrap.style.setProperty('--ar', String(ar));
  clear(E.center, wrap, info, warn, err, done, revisionPanel(), uploadsBox());
}

function exportDone(job) {
  const startAt = S.timeline?.musicStart ?? 0;
  return h(
    'div',
    { class: 'st-done' },
    h('b', {}, 'Exported. '),
    job.files.map((f) => {
      const { format, noMusic } = formatOfFile(f);
      const platform = PLATFORM_OF_FORMAT[format];
      const st = S.publish.find((x) => x.platform === platform);
      return h(
        'div',
        { class: 'st-row st-done-row' },
        h('a', { href: '#', onclick: (e) => (e.preventDefault(), api.show(f)) }, f.split(/[\\/]/).pop()),
        h('div', { class: 'st-spacer' }),
        st
          ? st.connected
            ? h('button', { class: 'st-btn small', disabled: S.uploads.some((u) => u.file === f && u.platform === platform && !['done', 'error'].includes(u.stage)), onclick: () => startUpload(S.project, f, platform) }, platform === 'tiktok' && st.tiktokMode !== 'direct' ? 'Send to TikTok drafts' : `Upload to ${st.label}`)
            : h('button', { class: 'st-btn small ghost', title: `Opens ${st.label}'s upload page, shows the file and copies your caption`, onclick: () => postByHand(f, st) }, `Post on ${st.label}`)
          : null,
        noMusic ? h('span', { class: 'st-note' }, 'no music') : null,
      );
    }),
    job.files.some((f) => f.includes('_nomusic')) && S.project.music ? h('p', { class: 'st-note' }, `For the no-music copy: add "${S.project.music.title}" in the app and set the sound to start at ${fmtTime(startAt, true)}.`) : null,
    h('div', { class: 'st-row' }, h('span', { class: 'st-note st-wrap' }, `In ${S.init.paths.reels}`), h('div', { class: 'st-spacer' }), h('button', { class: 'st-btn small ghost', onclick: () => api.openFolder('reels') }, 'Open folder')),
  );
}

function uploadsBox() {
  if (!S.uploads.length) return null;
  return h(
    'div',
    { class: 'st-uploads' },
    S.uploads.slice(-6).map((u) =>
      h(
        'div',
        { class: 'st-upload ' + u.stage },
        h('div', { class: 'st-row' }, h('b', {}, platformLabel(u.platform)), h('span', { class: 'st-clip-sub' }, u.file.split(/[\\/]/).pop()), h('div', { class: 'st-spacer' }), u.url ? h('a', { href: '#', onclick: (e) => (e.preventDefault(), api.openExternal(u.url)) }, 'Open') : null),
        u.stage === 'error' ? h('div', { class: 'st-warn' }, u.error || u.message) : h('div', { class: 'st-clip-sub' }, u.message),
        ['uploading', 'processing'].includes(u.stage) ? h('div', { class: 'st-bar' }, h('div', { style: { width: pct(u.pct || 0) } })) : null,
      ),
    ),
  );
}

async function startUpload(project, file, platform) {
  const st = S.publish.find((x) => x.platform === platform);
  const t = project.music ? trackOf(project.music.trackId) : null;
  if (platform !== 'tiktok' && t && !['own', 'royalty-free'].includes(t.license) && !file.includes('_nomusic')) {
    if (!confirm(`"${t.title}" isn't marked as royalty-free or yours, so ${st?.label ?? platform} may mute or block the upload. Upload anyway?`)) return;
  }
  try {
    const { uploadId } = await api.publish.upload(uploadRequest(project, file, platform, missingCredits(project)));
    S.uploads.push({ uploadId, platform, file, stage: 'uploading', pct: 0, message: 'Starting upload' });
  } catch (err) {
    toast(root, err.message, 'error', 8000);
  }
  renderCenter();
}

async function autoUploadAfterExport(job, files) {
  const proj = job.snapshot;
  for (const platform of job.autoUpload) {
    const mine = files.filter((f) => PLATFORM_OF_FORMAT[formatOfFile(f).format] === platform);
    if (!mine.length) {
      toast(root, `Nothing to upload to ${platformLabel(platform)}: export its format too.`, 'warn', 7000);
      continue;
    }
    const st = S.publish.find((x) => x.platform === platform);
    // TikTok drafts: the no-music copy, so you can add the official sound in the app.
    const pick = platform === 'tiktok' && st?.tiktokMode !== 'direct' ? mine.find((f) => f.includes('_nomusic')) ?? mine[0] : mine.find((f) => !f.includes('_nomusic')) ?? mine[0];
    await startUpload(proj, pick, platform);
  }
}

function onUploadProgress(p) {
  const u = S.uploads.find((x) => x.uploadId === p.uploadId);
  if (!u) return;
  Object.assign(u, p);
  if (p.stage === 'done') toast(root, p.message);
  if (p.stage === 'error') toast(root, `${platformLabel(p.platform)}: ${p.error}`, 'error', 9000);
  renderCenter();
}

function postByHand(file, st) {
  api.show(file);
  const caption = [S.project.caption?.trim(), missingCredits(S.project)].filter(Boolean).join('\n\n');
  if (caption) navigator.clipboard?.writeText(caption).catch(() => undefined);
  api.openExternal(st.uploadPageUrl);
  toast(root, `Opened ${st.label}. Drag the highlighted file in${caption ? ' and paste your caption (it\'s copied)' : ''}.`, 'info', 8000);
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
    recordUndo(); // keep the crop as it was before the drag
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
      // The drag already changed the clip; save it without a second undo step.
      saveSoon(S.project);
      planSoon();
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
    toggle({ label: 'Follow character', checked: c.followCharacter !== false, onChange: value => change(p => p.clips[idx].followCharacter = value, [renderCenter,renderRight]) }),
    toggle({ label: 'Keep kill feed visible', checked: c.preserveKillFeed !== false, onChange: value => change(p => p.clips[idx].preserveKillFeed = value, [renderCenter,renderRight]) }),
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
    vertical() || c.cropZoom > 1 ? h('p', { class: 'st-note' }, 'Automatic tracking follows the centre character area. Turn it off to use the crop box.') : null,
    slider({ label: 'Punch in', min: 1, max: 2, step: 0.05, value: c.cropZoom, format: (z) => `${z.toFixed(2)}×`, onInput: (z) => {
      setNum('cropZoom', z); // through change(), so Undo gets the zoom from before
      placeCrop();
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
    toggle({ label: 'Open with a hook card', checked: !!intro, onChange: (on) => change((pr) => (pr.intro = on ? { text: '', seconds: 4, layout: 'band' } : null), [renderRight]), hint: 'A picture with big text before the gameplay, like the reference edits. The cut into gameplay lands on the drop.' }),
    intro
      ? [
          h(
            'label',
            { class: 'st-field' },
            h('span', { class: 'st-label' }, 'Hook lines'),
            h('textarea', {
              rows: 3,
              value: intro.text,
              maxlength: 330,
              placeholder: "One line, or a short back-and-forth, one per line:\nWho's stronger?\nHim?\nOr you?",
              oninput: (e) => change((pr) => (pr.intro.text = e.target.value)),
            }),
            h('span', { class: 'st-note' }, 'Up to 4 lines. Each one shows in turn, so give each about 1.5 s.'),
          ),
          select({
            label: 'Layout',
            value: intro.layout ?? 'band',
            options: [['band', 'Picture across the middle, text under it'], ['full', 'Picture fills the screen']],
            onChange: (v) => change((pr) => (pr.intro.layout = v)),
          }),
          h(
            'div',
            { class: 'st-row' },
            h('button', { class: 'st-btn small', onclick: async () => {
              const img = await api.pickImage();
              if (img) change((pr) => ((pr.intro.image = img), delete pr.intro.imageCredit), [renderRight]);
            } }, intro.image ? 'Change image' : 'Pick image'),
            h('button', { class: 'st-btn small', title: 'Search free Creative Commons pictures', onclick: () => openFreeSearch(root, { kind: 'image', query: intro.text, onPick: (img) => change((pr) => {
              pr.intro.image = img.file;
              pr.intro.imageCredit = img.credit || undefined;
            }, [renderRight]) }) }, 'Find a picture'),
            intro.image ? h('span', { class: 'st-note' }, intro.image.split(/[\\/]/).pop()) : h('span', { class: 'st-note' }, 'No picture: uses a frame of your first clip'),
            intro.image ? h('button', { class: 'st-x', onclick: () => change((pr) => (delete pr.intro.image, delete pr.intro.imageCredit), [renderRight]) }, '×') : null,
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
    h('h3', {}, 'End text'),
    toggle({ label: 'Text over the last seconds', checked: !!p.outro, onChange: (on) => change((pr) => (pr.outro = on ? { text: 'Follow for part 2', seconds: 3 } : null), [renderRight]), hint: 'e.g. "Follow for part 2" or "Rate it 1-10". Shown big at the top while the reel fades out.' }),
    p.outro
      ? [
          h('label', { class: 'st-field' }, h('span', { class: 'st-label' }, 'Text'), h('input', { value: p.outro.text, maxlength: 100, oninput: (e) => change((pr) => (pr.outro.text = e.target.value)) })),
          slider({ label: 'Length', min: 1, max: 8, step: 0.5, value: p.outro.seconds, format: (v) => `${v} s`, onInput: (v) => change((pr) => (pr.outro.seconds = v)) }),
        ]
      : null,
    h('h3', {}, 'Post caption'),
    post,
    creditsFor(p)
      ? h(
          'div',
          { class: 'st-credit' },
          h('div', { class: 'st-note' }, 'Your song or picture needs a credit in the post:'),
          creditsFor(p).split('\n').map((line) => h('div', { class: 'st-clip-sub st-wrap' }, line)),
          creditsFor(p).split('\n').every((line) => (p.caption ?? '').includes(line)) ? h('span', { class: 'st-good' }, 'In the caption') : h('button', { class: 'st-btn small', onclick: () => change((pr) => (pr.caption = [pr.caption?.trim(), creditsFor(pr)].filter(Boolean).join('\n\n')), [renderRight]) }, 'Add to caption'),
        )
      : null,
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

/** "Saved to <folder>" with buttons to pick another folder on this PC, open it, or go back to the default. */
function exportFolderRow() {
  const label = h('span', { class: 'st-wrap' }, S.init.paths.reels);
  const isDefault = () => /[\\/]exports[\\/]reels$/i.test(S.init.paths.reels) && S.init.paths.reels.startsWith(S.init.paths.root);
  const reset = h('button', { class: 'st-btn small ghost', hidden: isDefault(), onclick: async () => update(await api.exportDir.reset()) }, 'Use default');
  const update = (dir) => {
    S.init.paths.reels = dir;
    label.textContent = dir;
    reset.hidden = isDefault();
  };
  return h(
    'div',
    { class: 'st-export-folder' },
    h('div', { class: 'st-note' }, 'Saved to ', label),
    h(
      'div',
      { class: 'st-row' },
      h('button', { class: 'st-btn small', onclick: async () => update(await api.exportDir.choose()) }, 'Change folder'),
      h('button', { class: 'st-btn small ghost', onclick: () => api.openFolder('reels') }, 'Open folder'),
      reset,
    ),
  );
}

async function startRender(req) {
  if (S.job && !['done', 'error', 'cancelled'].includes(S.job.stage)) return;
  saveSoon.flush(S.project);
  const request = { preview: !!req.preview, formats: req.formats ?? [S.project.format], noMusicCopy: !!req.noMusicCopy, gpu: !!req.gpu };
  const snapshot = structuredClone(S.project);
  const job = { jobId: undefined, autoUpload: req.autoUpload ?? [], snapshot, projectId: snapshot.id, projectName: snapshot.name, stage: 'clips', pct: 0, message: 'Starting…', preview: request.preview, key: planKey() };
  S.job = job;
  renderTop();
  renderCenter();
  try {
    // Uploads use the reel as it was rendered, even if it is edited while the export runs.
    const { jobId } = await api.render(snapshot, request);
    job.jobId = jobId;
  } catch (err) {
    job.stage = 'error';
    job.message = err.message;
    job.error = err.message;
    toast(root, err.message, 'error', 7000);
  }
  renderTop();
  renderCenter();
}

function onProgress(p) {
  if (!S.job || p.jobId !== S.job.jobId) return;
  Object.assign(S.job, p);
  if (p.stage === 'done') {
    if (S.creation && S.job.preview) { S.creation = {step: 'Preview ready', detail: 'Watch the result, then adjust or export.'}; renderLeft(); }
    // The job belongs to the reel it was started from, which may not be the one open now.
    // The main process has already recorded the export on that reel's history.
    const here = S.job.projectId === S.project.id;
    if (!S.job.preview && S.job.autoUpload?.length && p.files?.length) autoUploadAfterExport(S.job, p.files);
    if (S.job.preview) {
      if (here && p.files?.[0]) S.preview = { file: p.files[0], key: S.job.key, autoplay: true };
    } else if (here) {
      const proj = S.project;
      api.projects
        .get(proj.id)
        .then((saved) => saved && (proj.lastExports = saved.lastExports))
        .catch(() => undefined);
      toast(root, 'Export finished');
    } else {
      toast(root, `Export of "${S.job.projectName}" finished`);
    }
    renderTop();
  }
  if (p.stage === 'error' || p.stage === 'cancelled') {
    if (S.creation) { S.creation = {step: p.stage === 'cancelled' ? 'Preview cancelled' : 'Preview failed', error: p.error || p.message}; renderLeft(); }
    renderTop();
  }
  renderCenter();
}

function revisionPanel() {
  const text = h('textarea', {class:'st-revision-prompt', rows:3, maxlength:20000, placeholder:'What should change? For example: start on the first hit, lower game audio, use the triple last…',value:S.revisionRequest || '',oninput:e=>S.revisionRequest=e.target.value});
  return h('div',{class:'st-revision'}, h('label',{class:'st-label'},'Request changes'),text,
    h('button',{class:'st-btn primary',disabled:!S.init.ai.signedIn || S.busy.revise || (S.job && !['done','error','cancelled'].includes(S.job.stage)),onclick:async()=>{
      if (!S.revisionRequest?.trim() || S.busy.revise) return;
      S.busy.revise=true; S.revisionStatus='Applying your changes…'; renderCenter();
      const id=S.project.id;
      try {
        const result=await api.ai.reviseReel(structuredClone(S.project),S.revisionRequest);
        if (S.project.id!==id) throw new Error('The reel changed. Return to the original reel to apply the revision.');
        change(project=>Object.assign(project,result.project));
        S.revisionStatus=result.summary+' Rendering a new preview…';
        await startRender({preview:true});
      } catch(error) { S.revisionStatus=error.message; }
      finally { S.busy.revise=false; renderCenter(); }
    }},S.busy.revise?'Applying changes…':'Apply changes & preview'),
    S.revisionStatus?h('p',{class:'st-note',role:'status'},S.revisionStatus):null);
}

function openExport() {
  const p = S.project;
  const t = currentTrack();
  const chosen = new Set([p.format]);
  const gpuOk = S.init.ffmpeg.gpuEncoders.length > 0;
  let noMusic = !!p.music && fmt().music.inAppLibrary;
  let gpu = false;
  const autoUpload = new Set();
  const connected = S.publish.filter((x) => x.connected);
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
      exportFolderRow(),
      rows,
      h('hr'),
      p.music ? toggle({ label: 'Also save a copy without music', checked: noMusic, onChange: (v) => (noMusic = v), hint: 'Add the same song in TikTok or Instagram for full reach and no mute' }) : null,
      fmt().fpsOptions.length > 1
        ? select({ label: `Frame rate for ${fmt().label}`, value: p.fps, options: fmt().fpsOptions.map((x) => [x, `${x} fps`]), onChange: (v) => change((pr) => (pr.fps = Number(v))) })
        : null,
      h('hr'),
      connected.length
        ? [
            h('div', { class: 'st-label' }, 'Upload when it\'s done'),
            connected.map((st) => toggle({ label: st.platform === 'tiktok' && st.tiktokMode !== 'direct' ? `Send to TikTok drafts (${st.account ?? 'TikTok'})` : `Upload to ${st.label} (${st.account ?? st.label})`, checked: false, onChange: (v) => (v ? autoUpload.add(st.platform) : autoUpload.delete(st.platform)), hint: 'Uses the matching export: TikTok for TikTok, Reels for Instagram, Shorts or YouTube for YouTube' })),
          ]
        : h('p', { class: 'st-note' }, h('a', { href: '#', onclick: (e) => (e.preventDefault(), close(), openAccounts(root, S, () => (renderTop(), renderCenter()))) }, 'Upload accounts'), ' (optional, for later)'),
      toggle({ label: gpuOk ? `Faster export on the graphics card (${S.init.ffmpeg.gpuEncoders[0].replace('h264_', '').toUpperCase()})` : 'Faster export on the graphics card (not available)', checked: gpu, disabled: !gpuOk, onChange: (v) => (gpu = v) }),
      h(
        'div',
        { class: 'st-row end' },
        h('button', { class: 'st-btn ghost', onclick: close }, 'Cancel'),
        h('button', { class: 'st-btn primary', onclick: () => {
          if (!chosen.size) return;
          close();
          startRender({ preview: false, formats: [...chosen], noMusicCopy: noMusic, gpu, autoUpload: [...autoUpload] });
        } }, 'Export'),
      ),
    ),
  );
  root.append(modal);
}

function onKey(e) {
  if (!root?.isConnected || root.closest('.hidden')) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return;
  if (document.querySelector('.st-modal')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  if (mod && !e.altKey && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
    return;
  }
  if (e.code === 'Space') {
    const v = E.center?.querySelector('video.st-preview');
    if (v) {
      e.preventDefault();
      v.paused ? v.play() : v.pause();
    }
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) removeClip(S.sel);
}
