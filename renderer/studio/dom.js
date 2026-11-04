// Tiny DOM helpers for the Studio. No framework, no innerHTML with user data.

/** h('div', { class: 'x', onclick }, child, [children], 'text') */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v; // a textarea ignores the value attribute
    else if (k in el && typeof v !== 'string') el[k] = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

/** file:///F:/RivalsClips/... with the characters that break URLs escaped. */
export function fileUrl(p) {
  if (!p) return '';
  const norm = String(p).replace(/\\/g, '/');
  const withRoot = norm.startsWith('/') ? norm : '/' + norm;
  return 'file://' + encodeURI(withRoot).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

export function fmtTime(s, withTenths = false) {
  if (!Number.isFinite(s)) return '–';
  const neg = s < 0;
  s = Math.abs(s);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  const ss = withTenths ? sec.toFixed(1).padStart(4, '0') : String(Math.floor(sec)).padStart(2, '0');
  return `${neg ? '-' : ''}${m}:${ss}`;
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.flush = (...a) => {
    clearTimeout(t);
    fn(...a);
  };
  return d;
}

/** Labelled range slider. onInput gets the number. */
export function slider({ label, min, max, step, value, format, onInput, hint }) {
  const out = h('span', { class: 'st-val' }, format ? format(value) : value);
  const input = h('input', {
    type: 'range',
    min,
    max,
    step,
    value,
    oninput: (e) => {
      const v = Number(e.target.value);
      out.textContent = format ? format(v) : v;
      onInput(v);
    },
  });
  return h('label', { class: 'st-field', title: hint }, h('span', { class: 'st-label' }, label, out), input);
}

export function toggle({ label, checked, onChange, hint, disabled }) {
  return h(
    'label',
    { class: 'st-toggle' + (disabled ? ' disabled' : ''), title: hint },
    h('input', { type: 'checkbox', checked: !!checked, disabled: !!disabled, onchange: (e) => onChange(e.target.checked) }),
    h('span', {}, label),
  );
}

export function select({ label, value, options, onChange, hint }) {
  const sel = h(
    'select',
    { onchange: (e) => onChange(e.target.value) },
    options.map(([v, text]) => h('option', { value: v, selected: String(v) === String(value) }, text)),
  );
  return label ? h('label', { class: 'st-field', title: hint }, h('span', { class: 'st-label' }, label), sel) : sel;
}

export function toast(root, message, kind = 'info', ms = 4000) {
  let host = root.querySelector('.st-toasts');
  if (!host) host = root.appendChild(h('div', { class: 'st-toasts' }));
  const t = h('div', { class: `st-toast ${kind}` }, message);
  host.append(t);
  setTimeout(() => t.remove(), ms);
}
