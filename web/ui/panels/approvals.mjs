// web/ui/panels/approvals.mjs — pending approvals for gated agent actions.
// Read-only: resolving one is gated on a paired device's Ed25519 token (see
// daemon/routes/gateway_views.mjs), which the dashboard is not.
import { el, phead, chip, banner } from '../dom.mjs';
import { api } from '../api.mjs';
import { reconcile } from '../reconcile.mjs';
import { subscribe } from '../stream.mjs';
import { bumpNav } from '../shell.mjs';

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

function createRow(a) {
  // data-approval is a test hook only (no behaviour change). The Approve/Deny
  // buttons below stay `disabled` — resolving one is gated on a paired
  // device's Ed25519 token, which the dashboard is not (see the banner
  // above) — so this hook lets a test find a pending row without implying
  // the row is actionable from here.
  const tr = el('tr', { '--i': a.i, 'data-approval': a.id },
    el('td', {}, el('code', { text: a.tool || '' })),
    el('td', {}, a.agentId || ''),
    el('td', { class: 'mono' }, a.summary || ''),
    el('td', { 'data-f': 'remaining' }),
    el('td', {},
      el('button', { class: 'btn btn-secondary', type: 'button', disabled: true, text: 'Approve' }),
      el('button', { class: 'btn btn-secondary', type: 'button', disabled: true, text: 'Deny' })));
  updateRemaining(tr, a);
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
  host.append(banner('warn', '!', el('b', { text: 'Read-only in this release. ' }),
    'Resolving an approval is gated on a paired device’s Ed25519 token; the dashboard is not one yet. ',
    'Approve from a paired device or with ', el('code', { text: 'pompos nodes' }), '.'));

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
