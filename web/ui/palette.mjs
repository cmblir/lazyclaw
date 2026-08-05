// web/ui/palette.mjs — one keyboard entry point to everything.
//
// The point is that panel COUNT stops mattering: 21 today, more when channels
// and skills register their own, and reaching any of them is always the same
// two keystrokes. Ranking is a pure function so it can be tested.
import { el, clear } from './dom.mjs';
import { ALL } from './nav_model.mjs';
import { open } from './shell.mjs';

/**
 * Rank an item against a lowercased needle.
 *   >= 0  match (higher is better; an earlier substring beats a later one)
 *   < 0   no match
 * A subsequence match scores a flat 20, which is below every substring hit
 * (those start at 100 - index), so "team" always beats "tmlv".
 */
export function score(item, needle) {
  if (!needle) return 0;
  const hay = (item.label + ' ' + item.kind + ' ' + (item.hint || '')).toLowerCase();
  const idx = hay.indexOf(needle);
  if (idx >= 0) return 100 - idx;
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i += 1;
  return i === needle.length ? 20 : -1;
}

let extra = () => [];
let shown = [];
let sel = 0;

function items() {
  return [
    ...ALL.map((it) => ({ label: it.label, kind: 'panel', hint: it.group.toLowerCase(), go: it.id })),
    ...extra(),
  ];
}

export function mountPalette(opts = {}) {
  if (typeof opts.extraItems === 'function') extra = opts.extraItems;
  const scrim = document.getElementById('scrim');
  const q = document.getElementById('q');

  document.getElementById('omni').addEventListener('click', openPalette);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closePalette(); });
  q.addEventListener('input', () => { sel = 0; paint(); });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (shown[sel]) run(shown[sel]); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (!shown.length) return;
    sel = e.key === 'ArrowDown' ? (sel + 1) % shown.length : (sel - 1 + shown.length) % shown.length;
    paint();
  });
  // The modal (modal.mjs) is a higher stacking layer than the palette and has
  // its own Escape listener, scoped to its own #modal-scrim. If the modal is
  // open on top of the palette, this Escape belongs to it — skip here so one
  // keypress doesn't close both layers at once (the mirror image of the
  // drawer-vs-palette guard in shell.mjs).
  //
  // Registered with `capture: true` so the #modal-scrim read below happens
  // before modal.mjs's own (bubble-phase) Escape handler can close it —
  // modal.mjs's handler is registered earlier (shell.mjs's initModal(), which
  // runs before dashboard.js calls mountPalette()), so a plain bubble-phase
  // listener here would run AFTER it, see #modal-scrim already closed, and
  // close the palette too on the same keypress. Same reasoning as shell.mjs's
  // drawer guard.
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    else if (e.key === 'Escape' && scrim.hasAttribute('data-open')) {
      if (document.getElementById('modal-scrim').hasAttribute('data-open')) return;
      e.preventDefault();
      closePalette();
    }
  }, true);
}

export function openPalette() {
  document.getElementById('scrim').setAttribute('data-open', '');
  const q = document.getElementById('q');
  q.value = ''; sel = 0; paint(); q.focus();
}

export function closePalette() {
  document.getElementById('scrim').removeAttribute('data-open');
  document.getElementById('omni').focus();
}

function run(it) {
  closePalette();
  if (it.go) open(it.go);
  if (typeof it.then === 'function') it.then();
}

function paint() {
  const needle = document.getElementById('q').value.trim().toLowerCase();
  const results = document.getElementById('results');
  shown = items()
    .map((it) => ({ it, s: score(it, needle) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 8)
    .map((x) => x.it);

  clear(results);
  if (!shown.length) {
    results.append(el('li', { class: 'pal-empty', text: 'Nothing matches that.' }));
    return;
  }
  sel = Math.min(sel, shown.length - 1);
  shown.forEach((it, i) => {
    results.append(el('li', { '--i': i, 'data-sel': i === sel || null },
      el('button', { type: 'button', onclick: () => run(it) },
        el('span', { class: 'kind', text: it.kind }),
        el('span', { text: it.label }),
        el('span', { class: 'path', text: it.hint || '' }))));
  });
}
