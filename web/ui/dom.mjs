// web/ui/dom.mjs — element construction and the handful of shared visual
// primitives every panel needs. No framework: el() is a thin, predictable
// wrapper over document.createElement that keeps panel code declarative.

// Build an element. `props` is a flat bag:
//   class / text / style   -> the matching property
//   on<Event>              -> addEventListener
//   --custom-prop          -> style.setProperty (used for stagger indices)
//   anything else          -> setAttribute; null/undefined/false are skipped
//   so callers can write `disabled: !allowed || null` inline
// Children flatten one level and skip null/undefined/false.
export function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  for (const k in (props || {})) {
    const v = props[k];
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k.startsWith('--')) n.style.setProperty(k, v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(typeof kid === 'string' || typeof kid === 'number' ? String(kid) : kid);
  }
  return n;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// Status is never colour-alone: every chip carries a glyph and a word.
const TONE_ICON = { live: '●', ok: '✓', warn: '!', err: '✗', '': '○' };

export function chip(text, tone) {
  return el('span', { class: 'chip' + (tone ? ' is-' + tone : '') },
    el('span', { class: 'ic', 'aria-hidden': 'true', text: TONE_ICON[tone || ''] }),
    text);
}

export function phead(title, sub) {
  return el('div', { class: 'phead' }, el('h2', { text: title }), sub && el('p', { text: sub }));
}

// `--i` on each row is what the CSS stagger reads.
export function table(cols, rows) {
  const thead = el('thead', {}, el('tr', {}, cols.map((c) => el('th', { text: c.label }))));
  const tbody = el('tbody', {}, rows.map((r, i) => el('tr', { '--i': i },
    cols.map((c) => el('td', { class: c.class || '' }, r[c.key])))));
  return el('div', { class: 'scroll' }, el('table', { class: 'tbl' }, thead, tbody));
}

export function rowList(rows) {
  if (!rows.length) return el('div', { class: 'empty', text: 'Nothing here yet.' });
  return el('div', { class: 'stack' }, rows.map((r, i) => el('div', { class: 'srow', '--i': i },
    el('div', { style: 'min-width:0' },
      el('div', { class: 'who', text: r.who }),
      el('div', { class: 'what', text: r.what })),
    el('div', { class: 'acts' },
      r.tone !== undefined ? chip(r.state, r.tone) : null,
      r.acts || []))));
}

export function kvlist(pairs) {
  return el('dl', { class: 'kvlist' }, pairs.flatMap(([k, v, mono]) =>
    [el('dt', { text: k }), el('dd', { class: mono ? 'mono' : '', text: v })]));
}

export function banner(tone, icon, ...kids) {
  return el('div', { class: 'banner ' + tone },
    el('span', { class: 'ic', 'aria-hidden': 'true', text: icon }), ...kids);
}
