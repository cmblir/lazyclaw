// web/ui/shell.mjs — the frame around every panel: grouped sidebar, hash
// routing, the sliding active marker, and the mobile drawer.
//
// The URL hash stays the single source of truth for the active panel (as it
// was before the split), so deep links and reloads keep working. Setting the
// hash to a NEW value fires hashchange, which is the only activation path;
// setting it to the value it already has does not, so that case activates
// directly.
import { el, clear } from './dom.mjs';
import { GROUPS, ALL } from './nav_model.mjs';
import { initModal } from './modal.mjs';
import { watchVisibility } from './motion.mjs';
import { api } from './api.mjs';

export { GROUPS, ALL };

const navButtons = new Map();
let panels = {};
let host = null;
let rail = null;
let railScrim = null;
let burger = null;
let marker = null;
let currentId = null;
let cleanupFn = null;
let activationSeq = 0;

export function current() { return currentId; }

// Normalize a panel's render(host) return value into a cleanup callback.
// render() may be sync (returns a function, or nothing) or async (returns a
// Promise that resolves to a function, or nothing) — a panel author is free
// to write either, per Task 4. `onCleanup` is invoked with the real
// function-or-null once it's known: synchronously for the sync shapes,
// after the Promise settles for the async one. A rejected Promise or a
// resolved non-function value delivers null rather than throwing, so a
// panel author's mistake can't crash the shell.
//
// Exported (not inlined into activate()) so the async-resolution contract
// has a test that doesn't need to stub the whole DOM shell to exercise it.
export function resolveCleanup(renderResult, onCleanup) {
  const asFn = (v) => (typeof v === 'function' ? v : null);
  if (renderResult && typeof renderResult.then === 'function') {
    renderResult.then((v) => onCleanup(asFn(v)), () => onCleanup(null));
  } else {
    onCleanup(asFn(renderResult));
  }
}

export function mount(opts) {
  panels = opts.panels;
  host = document.getElementById('host');
  rail = document.getElementById('rail');
  railScrim = document.getElementById('rail-scrim');
  burger = document.getElementById('burger');
  marker = document.getElementById('nav-marker');

  const groupsEl = document.getElementById('nav-groups');
  clear(groupsEl);
  for (const g of GROUPS) {
    const wrap = el('div', { class: 'group' }, el('h2', { text: g.name }));
    for (const it of g.items) {
      const b = el('button', {
        type: 'button', class: 'nav-item', 'data-id': it.id,
        'aria-controls': 'host',
        onclick: () => { goto(it.id); closeDrawer(); },
      },
        el('span', { class: 'glyph', 'aria-hidden': 'true', text: it.glyph }),
        el('span', { text: it.label }),
        it.count != null ? el('span', { class: 'count', text: String(it.count) }) : null);
      wrap.append(b);
      navButtons.set(it.id, b);
    }
    groupsEl.append(wrap);
  }

  burger.addEventListener('click', () => (rail.hasAttribute('data-open') ? closeDrawer() : openDrawer()));
  railScrim.addEventListener('click', closeDrawer);
  // The drawer is a modal overlay on mobile — Escape is the expected way out.
  // The modal (a higher stacking layer, see modal.mjs) and the command
  // palette (palette.mjs, Task 9 — also a higher stacking layer, stacked
  // above the drawer but below the modal) each own their own Escape
  // listener; when either is open, Escape must close only that layer, so
  // skip the drawer here rather than closing both layers on one keypress.
  //
  // Registered with `capture: true` so this runs before modal.mjs's own
  // (bubble-phase) Escape handler can mutate #modal-scrim. All three
  // listeners sit on `window`, and bubble-phase listeners on the same
  // target fire in registration order — initModal() below registers
  // modal.mjs's handler AFTER this one, so on a keypress that closes the
  // modal, a bubble-phase version of this check would run second, read
  // #modal-scrim as already-closed, and wrongly fall through to close the
  // drawer too. Capture runs before any bubble listener anywhere, so the
  // read here is always the pre-keypress state. palette.mjs's own Escape
  // guard needs the same fix for the same reason (it checks #modal-scrim
  // too, and is registered later still, from dashboard.js).
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('modal-scrim').hasAttribute('data-open')) return;
    if (document.getElementById('scrim').hasAttribute('data-open')) return;
    if (rail.hasAttribute('data-open')) closeDrawer();
  }, true);
  window.addEventListener('hashchange', onHash);
  window.addEventListener('resize', () => moveMarker(navButtons.get(currentId)));

  // The shell owns startup wiring for every shell-level overlay, including
  // the modal's dismissal (× button / backdrop click / Escape) — modal.mjs
  // itself only holds open/close state and dismissal logic, not the wiring.
  initModal();
  // Ambient motion (the live rail sweep) pauses when the tab is hidden or
  // reduced motion is on, so a dashboard left open all day isn't animating
  // in the background for nothing.
  watchVisibility();

  // Status / version (always shown in the brand). A failed fetch — or a
  // response with no `.version` — leaves the "…" placeholder from the HTML
  // in place rather than writing "vundefined".
  api('/version').then((v) => {
    const versionEl = document.getElementById('version');
    if (versionEl && v && v.version) versionEl.textContent = `v${v.version}`;
  }).catch(() => {});

  onHash(true);
}

// Hash drives activation. A brand-new value fires hashchange; the same value
// does not, so activate directly in that case.
export function open(id) { goto(id); }

function goto(id) {
  if (!ALL.some((x) => x.id === id)) return;
  if (location.hash.slice(1) === id) activate(id);
  else {
    try { location.hash = id; } catch { activate(id); }
  }
}

function onHash(first) {
  const id = location.hash.slice(1);
  if (id && ALL.some((x) => x.id === id)) activate(id);
  else if (first) activate(ALL[0].id);
}

function activate(id) {
  currentId = id;
  for (const [key, b] of navButtons) {
    if (key === id) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  moveMarker(navButtons.get(id));

  if (cleanupFn) { try { cleanupFn(); } catch (_) { /* a panel teardown must not break navigation */ } cleanupFn = null; }
  clear(host);
  const panel = panels[id];
  if (!panel) {
    host.append(el('div', { class: 'empty', text: 'This panel is not wired up yet.' }));
    return;
  }
  // A panel that throws must not take the shell down with it. Tag this
  // activation with a sequence number: if the user has already navigated
  // away by the time an async render's cleanup resolves, run that cleanup
  // immediately instead of leaking (a resolved-but-never-stored cleanup is
  // exactly how Team Live's old SSE unsubscribe could go missing).
  const seq = ++activationSeq;
  try {
    resolveCleanup(panel.render(host), (fn) => {
      if (!fn) return;
      if (seq === activationSeq) cleanupFn = fn;
      else { try { fn(); } catch (_) { /* a stale cleanup must not break anything */ } }
    });
  } catch (e) {
    clear(host).append(el('div', { class: 'banner err' },
      el('span', { class: 'ic', 'aria-hidden': 'true', text: '✗' }),
      el('b', { text: 'This panel failed to render. ' }), String(e && e.message || e)));
  }
  host.getAnimations().forEach((a) => { a.cancel(); a.play(); });
}

// The marker is an absolutely-positioned child of the scrolling rail, so its
// offset is measured in CONTENT coordinates — viewport delta plus scrollTop.
function moveMarker(btn) {
  if (!btn || !marker) return;
  const box = btn.getBoundingClientRect();
  if (!box.height) return;
  const railBox = rail.getBoundingClientRect();
  marker.hidden = false;
  marker.style.height = Math.round(box.height - 12) + 'px';
  marker.style.transform = 'translateY(' + Math.round(box.top - railBox.top + 6 + rail.scrollTop) + 'px)';
}

// A badge that changes on its own must say so: a blocked agent waits behind
// the Approvals count.
export function bumpNav(id, count, urgent) {
  const b = navButtons.get(id);
  if (!b) return;
  let badge = b.querySelector('.count');
  if (!badge) { badge = el('span', { class: 'count' }); b.append(badge); }
  badge.textContent = String(count);
  badge.classList.toggle('urgent', !!urgent && count > 0);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  b.classList.remove('navbump');
  void b.offsetWidth;
  b.classList.add('navbump');
}

export function openDrawer() {
  rail.setAttribute('data-open', '');
  railScrim.setAttribute('data-open', '');
  burger.setAttribute('aria-expanded', 'true');
}

export function closeDrawer() {
  rail.removeAttribute('data-open');
  railScrim.removeAttribute('data-open');
  burger.setAttribute('aria-expanded', 'false');
}
