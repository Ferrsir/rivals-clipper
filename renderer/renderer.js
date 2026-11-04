/* global clipper */
const $ = (id) => document.getElementById(id);
let clips = [];

const fields = ['resolution', 'fps', 'gameAudio', 'recordMic', 'micDeviceId', 'useMicInReelsByDefault', 'preRollSeconds', 'postRollSeconds', 'manualClipHotkey'];

function renderStatus(s) {
  const bits = [s.msg];
  if (s.buffer) bits.push(`${s.buffer.width}×${s.buffer.height} @ ${s.buffer.fps}fps${s.buffer.micRecorded ? ' + mic' : ''}`);
  if (s.clipping) bits.push('● clipping');
  $('status').textContent = bits.join('  ·  ');
  $('status').classList.toggle('live', !!s.buffer);
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
      <div class="title"><strong>${kills} kill${kills === 1 ? '' : 's'}</strong> · ${c.hero ?? 'Unknown hero'} · ${c.match.map ?? ''}</div>
      <div class="muted">${when} · ${(c.durationMs / 1000).toFixed(0)}s · score <b>${c.score}</b></div>
      <div class="tags">${tags}</div>
      <div class="actions">
        <span class="stars">${[1, 2, 3, 4, 5].map((n) => `<button data-star="${n}" class="${(c.rating ?? 0) >= n ? 'on' : ''}">★</button>`).join('')}</span>
        ${hasMic ? `<label class="check"><input type="checkbox" class="useMic" ${c.useMic ? 'checked' : ''}> mic in reels</label>` : '<span class="muted">no mic track</span>'}
        <button class="exportGame">Export game audio</button>
        ${hasMic ? '<button class="exportMic">Export with mic</button>' : ''}
        <button class="show">Show file</button>
      </div>
    </div>`;
  li.querySelectorAll('[data-star]').forEach((b) =>
    b.addEventListener('click', async () => replace(await clipper.rate(c.videoFile, Number(b.dataset.star)))),
  );
  li.querySelector('.useMic')?.addEventListener('change', async (e) => replace(await clipper.setMic(c.videoFile, e.target.checked)));
  li.querySelector('.exportGame').addEventListener('click', () => clipper.exportClip(c.videoFile, false).catch(alert));
  li.querySelector('.exportMic')?.addEventListener('click', () => clipper.exportClip(c.videoFile, true).catch(alert));
  li.querySelector('.show').addEventListener('click', () => clipper.show(c.videoFile));
  return li;
}

function replace(updated) {
  if (!updated) return;
  const i = clips.findIndex((c) => c.videoFile === updated.videoFile);
  if (i >= 0) clips[i] = updated;
  else clips.unshift(updated);
  renderClips();
}

function renderClips() {
  const sorted = [...clips].sort((a, b) => ($('sort').value === 'score' ? b.score - a.score : b.createdAt - a.createdAt));
  const ul = $('clipList');
  ul.replaceChildren(...sorted.map(clipRow));
  $('count').textContent = `(${clips.length})`;
}

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
$('sort').addEventListener('change', renderClips);

clipper.onStatus(renderStatus);
clipper.onClip(replace);

(async () => {
  renderStatus(await clipper.status());
  await loadSettingsForm();
  clips = await clipper.listClips();
  renderClips();
})();
