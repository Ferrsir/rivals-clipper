// Free music/picture search, upload accounts and upload buttons for the Studio.

import { api } from './api.js';
import { fmtTime, h, toast } from './dom.js';

export const PLATFORM_OF_FORMAT = { tiktok: 'tiktok', reels: 'instagram', shorts: 'youtube', youtube: 'youtube', youtube1440: 'youtube' };
const LABEL = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram' };

export function formatOfFile(file) {
  const m = String(file).match(/_(tiktok|reels|shorts|youtube1440|youtube|square)(_nomusic)?\.mp4$/);
  return m ? { format: m[1], noMusic: !!m[2] } : { format: null, noMusic: false };
}

function modal(root, title, ...body) {
  const close = () => wrap.remove();
  const wrap = h('div', { class: 'st-modal', onclick: (e) => e.target === wrap && close() }, h('div', { class: 'st-dialog wide' }, h('div', { class: 'st-row' }, h('h2', {}, title), h('div', { class: 'st-spacer' }), h('button', { class: 'st-x', title: 'Close', onclick: close }, '×')), ...body));
  root.append(wrap);
  return { wrap, close };
}

const licenceText = (m) => (m.license === 'cc0' ? 'CC0 (no credit needed)' : m.license === 'pdm' ? 'Public domain' : `CC ${m.license.toUpperCase()} ${m.licenseVersion ?? ''} (credit needed)`);

/**
 * Search Openverse for Creative Commons music or pictures.
 * onPick gets the downloaded track (audio) or { file, credit } (image).
 */
export function openFreeSearch(root, { kind, query, onPick }) {
  const input = h('input', { type: 'search', value: query ?? '', placeholder: kind === 'audio' ? 'e.g. phonk, epic drop, dark trap' : 'e.g. shocked face, galaxy brain', maxlength: 120 });
  const results = h('div', { class: kind === 'audio' ? 'st-freelist' : 'st-freegrid' });
  const player = new Audio();
  let playing = null;
  const run = async () => {
    results.replaceChildren(h('p', { class: 'st-note' }, 'Searching…'));
    try {
      const items = await api.free.search(kind, input.value);
      results.replaceChildren();
      if (!items.length) results.append(h('p', { class: 'st-note' }, 'Nothing found. Try other words.'));
      for (const m of items) results.append(kind === 'audio' ? audioRow(m) : imageTile(m));
    } catch (err) {
      results.replaceChildren(h('p', { class: 'st-error' }, err.message));
    }
  };
  const take = async (m, btn) => {
    btn.disabled = true;
    btn.textContent = 'Downloading…';
    try {
      const r = kind === 'audio' ? await api.free.downloadMusic(m) : await api.free.downloadImage(m);
      player.pause();
      ui.close();
      onPick(r, m);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = kind === 'audio' ? 'Add to my music' : 'Use';
      toast(root, err.message, 'error', 7000);
    }
  };
  const audioRow = (m) => {
    const play = h('button', { class: 'st-play', title: 'Preview' }, '▶');
    play.onclick = () => {
      if (playing === m.id) {
        player.pause();
        playing = null;
        play.textContent = '▶';
        return;
      }
      for (const b of results.querySelectorAll('.st-play')) b.textContent = '▶';
      player.src = m.url;
      player.play().catch((e) => toast(root, `Can't play it: ${e.message}`, 'error'));
      playing = m.id;
      play.textContent = '■';
    };
    const add = h('button', { class: 'st-btn small' }, 'Add to my music');
    add.onclick = () => take(m, add);
    return h(
      'div',
      { class: 'st-track' },
      play,
      h(
        'div',
        { class: 'st-track-main' },
        h('div', { class: 'st-track-title' }, m.title, m.creator ? h('span', { class: 'muted' }, ` · ${m.creator}`) : null),
        h('div', { class: 'st-clip-sub' }, [m.durationSec ? fmtTime(m.durationSec) : null, licenceText(m), m.provider].filter(Boolean).join(' · ')),
        m.landingUrl ? h('a', { href: '#', class: 'st-small-link', onclick: (e) => (e.preventDefault(), api.openExternal(m.landingUrl)) }, 'Source page') : null,
      ),
      h('div', { class: 'st-track-actions' }, add),
    );
  };
  const imageTile = (m) => {
    const use = h('button', { class: 'st-btn small' }, 'Use');
    use.onclick = () => take(m, use);
    return h(
      'div',
      { class: 'st-freeimg', title: `${m.title}${m.creator ? ' by ' + m.creator : ''} · ${licenceText(m)}` },
      h('img', { src: m.thumbnail || m.url, alt: m.title, loading: 'lazy', referrerpolicy: 'no-referrer' }),
      h('div', { class: 'st-freeimg-meta' }, h('span', { class: 'st-clip-sub' }, licenceText(m)), use),
    );
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && run());
  const ui = modal(
    root,
    kind === 'audio' ? 'Find free music' : 'Find a picture',
    h('p', { class: 'st-note' }, kind === 'audio'
      ? 'Creative Commons and public-domain songs from Openverse (Jamendo, Freesound, ccMixter and more) that allow use in videos, including monetised ones. CC BY songs need a credit in your post, which the Studio adds for you.'
      : 'Creative Commons and public-domain pictures from Openverse (Wikimedia, Flickr and more) that allow editing and commercial use. CC BY pictures need a credit in your post.'),
    h('div', { class: 'st-row' }, input, h('button', { class: 'st-btn small', onclick: run }, 'Search')),
    results,
  );
  const stop = new MutationObserver(() => {
    if (!ui.wrap.isConnected) {
      player.pause();
      stop.disconnect();
    }
  });
  stop.observe(root, { childList: true });
  if (input.value.trim()) run();
  input.focus();
}

/** The accounts dialog: developer keys, connect and disconnect per platform. */
export function openAccounts(root, S, onChange) {
  const body = h('div', { class: 'st-accounts' });
  const draw = () => {
    body.replaceChildren();
    for (const st of S.publish) body.append(card(st));
  };
  const busy = new Set();
  const card = (st) => {
    const inputs = {};
    const fields = st.fields.map((f) => {
      const inp = h('input', { type: f.key === 'clientSecret' ? 'password' : 'text', placeholder: st.configured ? (f.key === 'clientSecret' ? 'Saved (leave empty to keep)' : 'Saved') : f.label, autocomplete: 'off', spellcheck: false });
      inputs[f.key] = inp;
      return h('label', { class: 'st-field' }, h('span', { class: 'st-label' }, f.label), inp);
    });
    const save = async () => {
      const cfg = {};
      for (const [k, inp] of Object.entries(inputs)) if (inp.value.trim()) cfg[k] = inp.value.trim();
      if (!Object.keys(cfg).length) return toast(root, 'Paste the keys first.');
      S.publish = await api.publish.configure(st.platform, cfg);
      toast(root, `${st.label} keys saved on this PC`);
      draw();
      onChange();
    };
    const act = async (fn, okMsg) => {
      if (busy.has(st.platform)) return;
      busy.add(st.platform);
      draw();
      try {
        S.publish = await fn();
        if (okMsg) toast(root, okMsg);
      } catch (err) {
        toast(root, err.message, 'error', 9000);
      } finally {
        busy.delete(st.platform);
        draw();
        onChange();
      }
    };
    const isBusy = busy.has(st.platform);
    return h(
      'div',
      { class: 'st-account' + (st.connected ? ' on' : '') },
      h('div', { class: 'st-row' }, h('b', {}, st.label), st.connected ? h('span', { class: 'st-badge' }, st.account || 'Connected') : st.configured ? h('span', { class: 'st-note' }, 'Keys saved, not signed in') : h('span', { class: 'st-note' }, 'Not set up')),
      h('p', { class: 'st-note' }, st.note),
      st.platform === 'tiktok'
        ? h(
            'div',
            { class: 'st-row' },
            h('span', { class: 'st-label' }, 'Mode'),
            h(
              'div',
              { class: 'st-seg' },
              [['inbox', 'Send to drafts'], ['direct', 'Post directly']].map(([m, label]) =>
                h('button', { class: st.tiktokMode === m ? 'on' : '', onclick: () => act(() => api.publish.configure('tiktok', { tiktokMode: m }), m === 'direct' ? 'Direct posting needs the video.publish scope. Connect again.' : null) }, label),
              ),
            ),
          )
        : null,
      st.connected
        ? h('div', { class: 'st-row' }, h('button', { class: 'st-btn small ghost', disabled: isBusy, onclick: () => act(() => api.publish.disconnect(st.platform, false)) }, 'Disconnect'), h('button', { class: 'st-btn small ghost', disabled: isBusy, onclick: () => act(() => api.publish.disconnect(st.platform, true)) }, 'Forget keys'))
        : [
            h('details', { class: 'st-setup', open: !st.configured },
              h('summary', {}, `How to get ${st.label} keys (one time, free)`),
              setupSteps(st),
            ),
            ...fields,
            h('div', { class: 'st-row' }, h('button', { class: 'st-btn small', onclick: save }, 'Save keys'), h('button', { class: 'st-btn small primary', disabled: !st.configured || isBusy, onclick: () => act(() => api.publish.connect(st.platform), `${st.label} connected`) }, isBusy ? 'Waiting for sign-in…' : `Connect ${st.label}`)),
          ],
    );
  };
  const ui = modal(root, 'Upload accounts', h('p', { class: 'st-note' }, 'Each platform only lets apps upload through a developer app of your own. Making one is free and takes about 10 minutes. Your keys and sign-ins stay on this PC, encrypted by Windows.'), body);
  draw();
  return ui;
}

function setupSteps(st) {
  const link = (text, url) => h('a', { href: '#', onclick: (e) => (e.preventDefault(), api.openExternal(url)) }, text);
  const steps =
    st.platform === 'youtube'
      ? [
          ['Open ', link('Google Cloud Console', 'https://console.cloud.google.com/projectcreate'), ' and create a project (any name).'],
          ['Enable the ', link('YouTube Data API v3', st.setupUrl), ' for it.'],
          ['Under APIs & Services, OAuth consent screen: choose External, fill in the app name and your email, and add yourself as a test user.'],
          ['Under Credentials, create an OAuth client ID of type "Desktop app". Copy its client ID and secret here.'],
        ]
      : st.platform === 'tiktok'
        ? [
            ['Open ', link('TikTok for Developers', st.setupUrl), ', sign in and create an app.'],
            ['Add the Login Kit and Content Posting API products. In Login Kit, choose Desktop and add the redirect URI ', h('code', {}, st.redirectUri), '.'],
            ['Request the scopes user.info.basic and video.upload (and video.publish if you want direct posting), then submit the app for review. Review usually takes a few days.'],
            ['Copy the client key and secret here.'],
          ]
        : [
            ['Make your Instagram account a Creator (or Business) account and link it to a Facebook Page (Instagram app, Settings, Account type).'],
            ['Open ', link('Meta for Developers', st.setupUrl), ' and create an app of type Business.'],
            ['Add Facebook Login for Business and Instagram, and add ', h('code', {}, st.redirectUri), ' as a valid OAuth redirect URI.'],
            ['While the app is in development mode it works for you (you are its admin) without Meta\'s review. Copy the app ID and app secret (App settings, Basic) here.'],
          ];
  return h('ol', { class: 'st-steps' }, steps.map((s) => h('li', {}, ...s)));
}

/** What to send for an exported file, using the reel's caption and credits. */
export function uploadRequest(project, file, platform, credits) {
  const caption = [project.caption?.trim(), credits].filter(Boolean).join('\n\n');
  const heroes = [...new Set(project.clips.map((c) => c.hero).filter(Boolean))];
  const hashtags = [...caption.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]);
  const title = (project.intro?.text || project.name || 'Marvel Rivals').trim();
  const { format } = formatOfFile(file);
  return {
    platform,
    file,
    title: platform === 'youtube' ? title : caption || title,
    description: caption,
    tags: platform === 'youtube' ? [...new Set(['Marvel Rivals', ...heroes, ...hashtags])] : [],
    privacy: 'public',
    shorts: format === 'shorts' || (platform === 'youtube' && format !== 'youtube' && format !== 'youtube1440'),
  };
}

export function platformLabel(p) {
  return LABEL[p] ?? p;
}
