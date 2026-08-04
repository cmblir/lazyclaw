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

export function current() { return currentId; }

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
  // The modal (a higher stacking layer, see modal.mjs) has its own Escape
  // listener; when it's open, Escape must close only the modal, so skip the
  // drawer here rather than closing both layers on one keypress.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('modal-scrim').hasAttribute('data-open')) return;
    if (rail.hasAttribute('data-open')) closeDrawer();
  });
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
  // A panel that throws must not take the shell down with it.
  try { cleanupFn = panel.render(host) || null; }
  catch (e) {
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
