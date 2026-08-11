// web/ui/panels/approvals.mjs — pending approvals for gated agent actions.
// Resolving one is gated on a paired device's Ed25519 token; this browser
// becomes one via web/ui/pairing.mjs, which mints a device token from a
// non-extractable key kept in IndexedDB. A bearer token alone still cannot
// resolve anything — that is the point of the gate.
import { el, phead, chip, banner } from '../dom.mjs';
import { api } from '../api.mjs';
import { reconcile } from '../reconcile.mjs';
import { subscribe } from '../stream.mjs';
import { bumpNav } from '../shell.mjs';
import { resolveApproval as resolveViaDevice, pairThisBrowser } from '../pairing.mjs';

// Matches gateway/http_gateway.mjs's own APPROVAL_TTL_MS. The route's
// response carries createdAt, not a deadline, so the countdown shown here is
// derived from this constant rather than invented client-side.
const APPROVAL_TTL_MS = 5 * 60 * 1000;

function remainingMs(createdAt) {
  return Math.max(0, APPROVAL_TTL_MS - (Date.now() - (createdAt || 0)));
}

// An agent is blocked while this is nonzero, so the word — not just the
// meter's colour — always says how urgent it is.
function timeChip(ms) {
  const s = Math.ceil(ms / 1000);
  if (ms === 0) return chip('expiring', 'err');
  return chip(s + 's left', s <= 30 ? 'err' : 'warn');
}

function meterEl(ms) {
  const frac = Math.max(0, Math.min(1, ms / APPROVAL_TTL_MS));
  return el('div', { class: 'meter' },
    el('i', { class: frac <= 0.25 ? 'warn' : '', style: `transform: scaleX(${frac})` }));
}

function updateRemaining(tr, a) {
  const cell = tr.querySelector('[data-f="remaining"]');
  if (!cell) return;
  const ms = remainingMs(a.createdAt);
  cell.replaceChildren(timeChip(ms), meterEl(ms));
}

// The action cell, rebuilt in place so success, failure and the not-paired
// prompt all render through one function. `deps` is threaded through rather
// than reached for globally, so _decide's tests swap the two network calls
// without any module-level state.
function renderActions(tr, a, { message = '', pair = false, done = '' } = {}, deps = {}) {
  const cell = tr.querySelector('[data-f="actions"]');
  if (!cell) return;
  const kids = [];
  if (done) {
    kids.push(chip(done, done === 'approved' ? 'ok' : 'warn'));
    for (const label of ['Approve', 'Deny']) {
      kids.push(el('button', { class: 'btn btn-secondary', type: 'button', disabled: true, text: label }));
    }
  } else {
    for (const [label, decision] of [['Approve', 'approve'], ['Deny', 'deny']]) {
      const b = el('button', { class: 'btn btn-secondary', type: 'button', text: label });
      b.addEventListener('click', () => { _decide(tr, a, a.id, decision, deps); });
      kids.push(b);
    }
  }
  if (message) kids.push(el('div', { class: 'err-inline', text: message }));
  if (pair) {
    const pairFn = deps.pairThisBrowser || pairThisBrowser;
    const b = el('button', { class: 'btn btn-secondary', type: 'button', text: 'Pair this browser' });
    b.addEventListener('click', async () => {
      const out = await pairFn();
      // Offer the button again only when pressing it could plausibly help.
      // NO_WEBCRYPTO / NO_ED25519 mean this browser can never pair (a
      // non-secure origin, or no Ed25519 support), and PENDING_APPROVAL means
      // the operator has to act next — re-offering it in those three cases is a
      // button that cannot work.
      const retryable = !['PENDING_APPROVAL', 'NO_WEBCRYPTO', 'NO_ED25519'].includes(out.code);
      renderActions(tr, a, out.ok ? {} : { message: out.error, pair: retryable }, deps);
    });
    kids.push(b);
  }
  cell.replaceChildren(...kids);
}

/**
 * Answer one approval. Exported for tests; `deps` swaps the two network calls.
 * Three outcomes and no others: resolved (buttons stay disabled, SSE drops the
 * row), failed (buttons come back plus the reason — the agent is STILL blocked,
 * so the row must not vanish), or not paired (the same, plus a pair button).
 */
export async function _decide(tr, a, id, decision, deps = {}) {
  const resolve = deps.resolveApproval || resolveViaDevice;
  const cell = tr.querySelector('[data-f="actions"]');
  if (!cell) return;
  cell.replaceChildren(el('span', { class: 'muted', text: decision === 'approve' ? 'Approving…' : 'Denying…' }));
  let out;
  try { out = await resolve(id, decision); }
  catch (e) { out = { ok: false, code: 'RESOLVE_FAILED', error: e && e.message ? e.message : String(e) }; }
  if (out && out.ok) {
    renderActions(tr, a, { done: out.approved ? 'approved' : 'denied' }, deps);
    return;
  }
  renderActions(tr, a, { message: out.error || 'the decision could not be delivered', pair: out.code === 'NOT_PAIRED' }, deps);
}

function createRow(a) {
  const tr = el('tr', { '--i': a.i, 'data-approval': a.id },
    el('td', {}, el('code', { text: a.tool || '' })),
    el('td', {}, a.agentId || ''),
    el('td', { class: 'mono' }, a.summary || ''),
    el('td', { 'data-f': 'remaining' }),
    el('td', { 'data-f': 'actions' }));
  updateRemaining(tr, a);
  renderActions(tr, a);
  return tr;
}

function updateRow(tr, a) {
  updateRemaining(tr, a);
}

// Refresh just the sidebar badge — used both by this panel's own load() and
// by the module-level stream subscription below, so the count is right
// whether or not Approvals is the active panel.
async function refreshBadge() {
  try {
    const body = await api('/approvals');
    bumpNav('approvals', Array.isArray(body.pending) ? body.pending.length : 0, true);
  } catch { /* a bad poll must not throw into the SSE fan-out */ }
}

// Registered once, at module load — NOT inside render() — so it keeps
// running (and the nav badge keeps moving) while some other panel is open.
// exec.approval.requested/resolved arrive on the shared SSE bus regardless
// of which panel is mounted (web/ui/stream.mjs).
subscribe((type) => {
  if (type === 'exec.approval.requested' || type === 'exec.approval.resolved') refreshBadge();
});

export async function render(host) {
  host.append(phead('Approvals', 'Actions waiting on a human before an agent can proceed.'));
  host.append(banner('info', 'i', el('b', { text: 'Approving from here pairs this browser. ' }),
    'The first decision generates an Ed25519 key for this browser and pairs it as a device; ',
    'the private key never leaves the browser and cannot be exported. ',
    'Only a paired device can answer one of these — there is no terminal command that does it. ',
    el('code', { text: 'pompos nodes' }), ' manages devices, not approvals.'));

  const tbody = el('tbody', {});
  const tableWrap = el('div', { class: 'scroll' }, el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {}, ['Tool', 'Agent', 'Summary', 'Remaining', ''].map((t) => el('th', { text: t })))),
    tbody));

  let shown = el('div', { class: 'empty', text: 'Loading…' });
  host.append(shown);
  function show(node) { if (shown !== node) { shown.replaceWith(node); shown = node; } }

  let latest = [];
  // reconcile()'s own return value — surviving nodes keyed by approval id —
  // so a resolved/timed-out approval's row is dropped here too, instead of
  // this panel holding a reference forever.
  let rowsByKey = new Map();

  async function load() {
    try {
      const body = await api('/approvals');
      latest = Array.isArray(body.pending) ? body.pending : [];
      bumpNav('approvals', latest.length, true);
      if (!latest.length) {
        rowsByKey = new Map();
        show(el('div', { class: 'empty', text: 'Nothing waiting — no agent is blocked on a human right now.' }));
        return;
      }
      show(tableWrap);
      rowsByKey = reconcile(tbody, latest.map((a, i) => ({ ...a, i })), (a) => a.id, createRow, updateRow);
    } catch (e) {
      show(el('div', { class: 'empty', text: 'Error: ' + e.message }));
    }
  }

  // The countdown runs at every motion level — an agent is blocked, so the
  // remaining time is information, not decoration.
  function tick() {
    for (const a of latest) {
      const tr = rowsByKey.get(a.id);
      if (tr) updateRemaining(tr, a);
    }
  }
  const timer = setInterval(tick, 1000);

  await load();
  return () => clearInterval(timer);
}
