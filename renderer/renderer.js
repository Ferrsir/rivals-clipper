/* global clipper */
const $ = (id) => document.getElementById(id);
let clips = [];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const aiReady = () => !!(ai && ai.provider !== 'none' && ai[ai.provider]?.loggedIn);

const fields = ['resolution', 'fps', 'gameAudio', 'recordMic', 'micDeviceId', 'useMicInReelsByDefault', 'clipPractice', 'aiTagging', 'preRollSeconds', 'postRollSeconds', 'manualClipHotkey'];

function renderStatus(s) {
  const bits = [s.msg];
  if (s.buffer) bits.push(`${s.buffer.width}×${s.buffer.height} @ ${s.buffer.fps}fps${s.buffer.micRecorded ? ' + mic' : ''}`);
  if (s.clipping) bits.push('● clipping');
  $('status').textContent = bits.join('  ·  ');
  $('status').classList.toggle('live', !!s.buffer);
  const warn = $('packagesWarning');
  warn.textContent = s.packagesProblem ?? '';
  warn.classList.toggle('hidden', !s.packagesProblem);
}

function clipRow(c) {
  const li = document.createElement('li');
  const kills = c.events.filter((e) => e.type === 'kill').length;
  const when = new Date(c.createdAt).toLocaleString();
  const tags = c.tags.filter((t) => !t.includes(':')).join(' ');
  const hasMic = c.audioTracks.length > 1;
  li.innerHTML = `
    <video src="file:///${c.videoFile.replace(/\\/g, '/')}" preload="metadata" controls></video>
    <div class="meta">
      <div class="title"><strong>${kills} kill${kills === 1 ? '' : 's'}</strong> · ${esc(c.hero ?? 'Unknown hero')} · ${esc(c.match.map ?? '')}</div>
      <div class="muted">${when} · ${(c.durationMs / 1000).toFixed(0)}s · score <b>${c.score}</b></div>
      ${c.ai?.summary ? `<div class="summary">“${esc(c.ai.summary)}”${c.ai.hype ? ` <span class="muted">hype ${c.ai.hype}/10</span>` : ''}</div>` : ''}
      ${c.ai?.error ? `<div class="muted small">AI tagging failed: ${esc(c.ai.error)}</div>` : ''}
      <div class="tags">${esc(tags)}</div>
      <div class="actions">
        <span class="stars">${[1, 2, 3, 4, 5].map((n) => `<button data-star="${n}" class="${(c.rating ?? 0) >= n ? 'on' : ''}">★</button>`).join('')}</span>
        ${hasMic ? `<label class="check"><input type="checkbox" class="useMic" ${c.useMic ? 'checked' : ''}> mic in reels</label>` : '<span class="muted">no mic track</span>'}
        <button class="delete" title="Move to the Recycle Bin">Delete</button>
        <button class="exportGame">Export game audio</button>
        ${hasMic ? '<button class="exportMic">Export with mic</button>' : ''}
        <button class="show">Show file</button>
        ${aiReady() ? `<button class="aiTag">${c.ai && !c.ai.error ? 'Re-tag with AI' : 'Tag with AI'}</button>` : ''}
      </div>
    </div>`;
  li.querySelectorAll('[data-star]').forEach((b) =>
    b.addEventListener('click', async () => replace(await clipper.rate(c.videoFile, Number(b.dataset.star)))),
  );
  li.querySelector('.useMic')?.addEventListener('change', async (e) => replace(await clipper.setMic(c.videoFile, e.target.checked)));
  li.querySelector('.delete').addEventListener('click', async () => {
    if (!confirm('Move this clip to the Recycle Bin?')) return;
    await clipper.deleteClip(c.videoFile).catch(alert);
    await refreshFacets();
    await runQuery();
  });
  li.querySelector('.exportGame').addEventListener('click', () => clipper.exportClip(c.videoFile, false).catch(alert));
  li.querySelector('.exportMic')?.addEventListener('click', () => clipper.exportClip(c.videoFile, true).catch(alert));
  li.querySelector('.show').addEventListener('click', () => clipper.show(c.videoFile));
  li.querySelector('.aiTag')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Tagging…';
    replace(await clipper.aiTag(c.videoFile).catch((err) => (alert(err), undefined)));
  });
  return li;
}

// A clip was saved or changed (rating, mic): refresh counts and re-run the current filters.
async function replace(updated) {
  if (!updated) return;
  await refreshFacets();
  await runQuery();
}

// ---------- library filters ----------
const activeTags = new Set();
let libraryTotal = 0;

function currentQuery() {
  return {
    text: $('q').value,
    hero: $('fHero').value || undefined,
    map: $('fMap').value || undefined,
    gameType: $('fType').value || undefined,
    minKills: Number($('fKills').value) || undefined,
    minRating: Number($('fRating').value) || undefined,
    tags: [...activeTags],
    sort: $('sort').value,
    limit: 200,
  };
}

function fillSelect(el, facets, allLabel) {
  const keep = el.value;
  el.replaceChildren(new Option(allLabel, ''), ...facets.map((f) => new Option(`${f.value} (${f.count})`, f.value)));
  el.value = facets.some((f) => f.value === keep) ? keep : '';
}

async function refreshFacets() {
  const f = await clipper.clipFacets();
  libraryTotal = f.total;
  fillSelect($('fHero'), f.heroes, 'All heroes');
  fillSelect($('fMap'), f.maps, 'All maps');
  fillSelect($('fType'), f.gameTypes, 'All modes');
  for (const t of [...activeTags]) if (!f.tags.some((x) => x.value === t)) activeTags.delete(t);
  $('tagChips').replaceChildren(
    ...f.tags.map((t) => {
      const b = document.createElement('button');
      b.className = `chip${activeTags.has(t.value) ? ' on' : ''}`;
      b.textContent = `${t.value} ${t.count}`;
      b.onclick = () => {
        if (activeTags.has(t.value)) activeTags.delete(t.value);
        else activeTags.add(t.value);
        b.classList.toggle('on');
        void runQuery();
      };
      return b;
    }),
  );
}

async function runQuery() {
  const r = await clipper.queryClips(currentQuery());
  clips = r.items;
  renderClips(r.total);
}

let queryTimer;
function queueQuery() {
  clearTimeout(queryTimer);
  queryTimer = setTimeout(runQuery, 150);
}

function renderClips(total = clips.length) {
  $('clipList').replaceChildren(...clips.map(clipRow));
  $('count').textContent = total === libraryTotal ? `(${libraryTotal})` : `(${total} of ${libraryTotal})`;
  const empty = $('emptyLibrary');
  empty.classList.toggle('hidden', clips.length > 0);
  empty.textContent = libraryTotal
    ? 'No clips match these filters.'
    : 'No clips yet. Play a match and your kills will show up here, ranked.';
}

$('q').addEventListener('input', queueQuery);
for (const id of ['fHero', 'fMap', 'fType', 'fKills', 'fRating']) $(id).addEventListener('change', runQuery);
$('aiTagAll').addEventListener('click', async () => {
  if (!aiReady()) return alert('Sign in to Claude or ChatGPT first (Settings, Account).');
  const n = await clipper.aiTagUntagged();
  $('aiTagAll').textContent = n ? `Tagging ${n} clip${n === 1 ? '' : 's'}…` : 'Every clip is tagged';
  setTimeout(() => ($('aiTagAll').textContent = 'AI-tag untagged clips'), 4000);
});
$('clearFilters').addEventListener('click', () => {
  $('q').value = '';
  for (const id of ['fHero', 'fMap', 'fType']) $(id).value = '';
  $('fKills').value = '0';
  $('fRating').value = '0';
  activeTags.clear();
  void refreshFacets().then(runQuery);
});

async function loadSettingsForm() {
  const s = await clipper.getSettings();
  $('rootFolder').value = s.rootFolder;
  const mics = await clipper.listMics();
  for (const m of mics) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.name + (m.isDefault ? ' (default)' : '');
    $('micDeviceId').appendChild(o);
  }
  for (const f of fields) {
    const el = $(f);
    if (el.type === 'checkbox') el.checked = !!s[f];
    else el.value = s[f];
  }
}

function readForm() {
  const patch = {};
  for (const f of fields) {
    const el = $(f);
    patch[f] = el.type === 'checkbox' ? el.checked : el.type === 'number' || f === 'fps' ? Number(el.value) : el.value;
  }
  patch.rootFolder = $('rootFolder').value;
  return patch;
}

$('save').addEventListener('click', async () => {
  await clipper.setSettings(readForm());
  $('save').textContent = 'Saved';
  setTimeout(() => ($('save').textContent = 'Save settings'), 1200);
});
$('pickFolder').addEventListener('click', async () => {
  const p = await clipper.pickFolder();
  if (p) $('rootFolder').value = p;
});
$('openFolder').addEventListener('click', () => clipper.openFolder());
$('sort').addEventListener('change', runQuery);

clipper.onStatus(renderStatus);
clipper.onClip(replace);

// ---------- tabs ----------
let studioMounted = false;
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `tab-${name}`));
  if (name === 'studio' && !studioMounted) {
    studioMounted = true;
    // The Studio is a separate ES module (renderer/studio/index.js) that owns #studio-root.
    import('./studio/index.js')
      .then((m) => m.mount($('studio-root')))
      .catch((err) => console.warn('Studio not available yet', err));
  }
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

// ---------- sign-in ----------
const LABEL = { claude: 'Claude', codex: 'ChatGPT' };
const CLI = { claude: 'Claude Code', codex: 'Codex' };
let ai = null;

function providerState(s) {
  if (!s.installed) return { text: `Needs the free ${CLI[s.provider]} app first.`, action: `Install ${CLI[s.provider]}`, kind: 'install' };
  if (!s.loggedIn) return { text: 'Installed, not signed in.', action: `Sign in with ${LABEL[s.provider]}`, kind: 'login' };
  return { text: 'Signed in.', action: `Use ${LABEL[s.provider]}`, kind: 'use' };
}

async function doAction(provider, kind, btn, statusEl) {
  if (kind === 'install') {
    await clipper.ai.install(provider);
    statusEl.textContent = 'Installer opened in a PowerShell window. When it finishes, click Check again.';
    btn.textContent = 'Check again';
    btn.onclick = () => refreshAi();
    return;
  }
  if (kind === 'login') {
    btn.disabled = true;
    statusEl.textContent = 'Finish signing in in your browser…';
    const r = await clipper.ai.login(provider);
    btn.disabled = false;
    if (!r.loggedIn) statusEl.textContent = 'Sign-in did not finish. Try again.';
    else enterApp();
    await refreshAi();
    return;
  }
  await clipper.ai.use(provider);
  enterApp();
  await refreshAi();
}

function renderProviderCards(container, statuses, compact) {
  container.querySelectorAll('.provider').forEach((card) => {
    const p = card.dataset.provider;
    const st = providerState(statuses[p]);
    const statusEl = card.querySelector('.pstatus');
    const btn = card.querySelector('.act');
    const active = ai.provider === p && statuses[p].loggedIn;
    const acct = statuses[p].account ? ` (${statuses[p].account})` : '';
    statusEl.textContent = active ? `Signed in${acct}, active. Uses the ${CLI[p]} login on this PC.` : st.text;
    btn.textContent = active ? 'Active' : st.action;
    btn.disabled = active;
    btn.onclick = () => doAction(p, st.kind, btn, statusEl);
    const out = card.querySelector('.logout');
    if (out) {
      out.classList.toggle('hidden', !statuses[p].loggedIn);
      out.onclick = async () => {
        await clipper.ai.logout(p);
        await refreshAi();
      };
    }
  });
}

function buildAccountList() {
  $('accountList').innerHTML = ['claude', 'codex']
    .map((p) => `<div class="provider" data-provider="${p}"><h2>${LABEL[p]}</h2><p class="pstatus muted"></p><span class="row"><button class="primary act"></button><button class="logout hidden">Sign out</button></span></div>`)
    .join('');
}

async function refreshAi() {
  ai = await clipper.ai.status();
  renderProviderCards($('signin'), ai, false);
  renderProviderCards($('accountList'), ai, true);
  const active = ai.provider !== 'none' && ai[ai.provider]?.loggedIn ? LABEL[ai.provider] : null;
  const acct = active && ai[ai.provider].account ? ` (${ai[ai.provider].account})` : '';
  $('accountBadge').textContent = active ? `Signed in: ${active}${acct}` : 'Not signed in';
  return ai;
}

function showAutoSigninNotice(provider, st) {
  const who = st.account ? ` as ${st.account}` : '';
  const el = $('autoSigninNotice');
  el.innerHTML = `Signed in automatically with <b>${LABEL[provider]}</b>${who}, using the ${CLI[provider]} login already on this PC. <button class="link" id="openAccount">Change in Settings</button> <button class="link" id="dismissNotice">Dismiss</button>`;
  el.classList.remove('hidden');
  $('openAccount').onclick = () => { showTab('settings'); el.classList.add('hidden'); };
  $('dismissNotice').onclick = () => el.classList.add('hidden');
}

function enterApp() {
  $('signin').classList.add('hidden');
  $('app').classList.remove('hidden');
}

$('skipSignin').addEventListener('click', async () => {
  await clipper.ai.use('none');
  enterApp();
  await refreshAi();
});

// ---------- boot ----------
(async () => {
  buildAccountList();
  const s = await refreshAi();
  const signedIn = s.provider !== 'none' && s[s.provider]?.loggedIn;
  if (s.onboarded && (signedIn || s.provider === 'none')) enterApp();
  else if (!s.onboarded && (s.claude.loggedIn || s.codex.loggedIn)) {
    // Already signed in from before: pick it automatically ("logs you in" on open), and say so.
    const picked = s.claude.loggedIn ? 'claude' : 'codex';
    await clipper.ai.use(picked);
    await refreshAi();
    enterApp();
    showAutoSigninNotice(picked, s[picked]);
  } else $('signin').classList.remove('hidden');

  renderStatus(await clipper.status());
  await loadSettingsForm();
  await refreshFacets();
  await runQuery();
})();
