// web/ui/panels/tasks.mjs — read-mostly task list with done/abandon actions.
// Tasks are created via the CLI (`lazyclaw task start`), not from here.
import { el, phead, chip, banner, clear, kvlist } from '../dom.mjs';
import { api, apiRaw } from '../api.mjs';
import { openModal, closeModal } from '../modal.mjs';
import { reconcile } from '../reconcile.mjs';

// Same columns table() would have used — kept here so the header can be
// built once, up front, instead of every load().
const COLS = ['id', 'title', 'team', 'lead', 'origin', 'permission', 'status', 'turns', 'opened', ''];

// `class: 'status status-' + t.status` used to render here — no CSS rule
// ever matched either class, so a task's status has been unstyled text
// since Task 7 flagged it. chip() is the repo's styled status primitive, and
// status is never colour-alone: every tone below still shows the word.
const STATUS_TONE = { pending: '', running: 'live', paused: 'warn', done: 'ok', failed: 'err', abandoned: 'warn' };

function statusChip(status) {
  return chip(status, STATUS_TONE[status] ?? '');
}

// Where a task came from. A channel-originated task carries the channel and
// the thread timestamp, so the row can point back at the conversation.
function originChip(t) {
  if (!t.slackChannel) return chip('started in the CLI', '');
  return el('span', { class: 'chip is-live', title: 'slackThreadTs ' + (t.slackThreadTs || '—') },
    el('span', { class: 'ic', 'aria-hidden': 'true', text: '⇄' }),
    t.slackChannel);
}

// The permission posture the task actually ran with. A channel task that has
// NOT been opted into unattended execution ran read-only — that is the safe
// case, not a warning; a channel task that CAN write/exec is what deserves
// the operator's attention.
function permissionChip(t) {
  return t.attended ? chip(t.permissionMode, 'ok') : chip('read-only · ' + t.permissionMode, 'warn');
}

function turnsText(t) {
  return String(Array.isArray(t.turns) ? t.turns.length : 0);
}

// GET /tasks/:id/transcript has always existed; nothing in the UI ever
// called it. Exported so Recall (web/ui/panels/recall.mjs) can open the same
// modal for a `task:` search hit.
export async function transcriptModal(t) {
  // The transcript route's default format is plain text (see
  // daemon/routes/registry.mjs taskTranscript), not JSON — apiSoft() always
  // tries r.json() and swallows a parse failure to null, so it can never
  // return this body as a string. Fetch it the same way sessions.mjs /
  // skills.mjs read a text endpoint: apiRaw() + r.text().
  const r = await apiRaw(`/tasks/${encodeURIComponent(t.id)}/transcript`);
  const status = r.status;
  const text = await r.text().catch(() => '');
  openModal({
    title: t.id + ' — transcript',
    // `.frow`/`.val`/a `.raw` pre class and a `.ghost` button appear nowhere
    // in dashboard.css or any other panel — kvlist() (dom.mjs), a bare <pre>
    // (styled globally, see sessions.mjs's own export modal), and
    // `btn btn-secondary` (every other panel's modal Close/Cancel button)
    // are this repo's real, styled equivalents.
    body: [
      kvlist([['Origin', t.slackChannel
        ? `${t.slackChannel} · thread ${t.slackThreadTs || '—'}`
        : 'lazyclaw task start · no channel', true]]),
      t.attended ? null : banner('warn', '!', el('b', { text: 'Ran read-only. ' }),
        `permission mode "${t.permissionMode}" — an unattended channel task cannot write files or run commands.`),
      status === 200
        ? el('pre', { text })
        : banner('err', '✗', 'Could not load the transcript (HTTP ' + status + ').'),
      el('div', { class: 'note-inline' }, el('b', { text: 'Also searchable. ' }),
        'Every turn is mirrored into the search index as ',
        el('code', { text: 'session_id = task:' + t.id }), ', so Recall finds it by content.'),
    ],
    foot: [el('button', { class: 'btn btn-secondary', type: 'button', text: 'Close', onclick: closeModal })],
  });
}

export async function render(host) {
  host.append(phead('Tasks', 'Tasks are created via lazyclaw task start.'));

  // Cleared and re-populated by load(): a banner appears only while at least
  // one listed task ran unattended (see withPosture in
  // daemon/routes/registry.mjs), and disappears again once it doesn't.
  const postureBanner = el('div', {});
  host.append(postureBanner);

  // The table shell is built once; only its rows are reconciled per load(),
  // so an in-place status change no longer discards every other row's node.
  const tbody = el('tbody', {});
  const tableWrap = el('div', { class: 'scroll' }, el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {}, COLS.map((c) => el('th', { text: c })))), tbody));

  let shown = el('div', { class: 'empty', text: 'Loading…' });
  host.append(shown);
  function show(node) { shown.replaceWith(shown = node); }

  // Transcript is always available — even (especially) for a finished task —
  // so it is unconditional; Mark done / Abandon only apply to open statuses.
  function actionsFor(t) {
    const kids = [el('button', { class: 'btn btn-secondary', type: 'button', text: 'Transcript', onclick: () => transcriptModal(t) })];
    if (t.status === 'running' || t.status === 'pending' || t.status === 'paused') {
      kids.push(
        el('button', { class: 'btn btn-secondary', type: 'button', text: 'Mark done', onclick: () => closeTask(t.id, 'done') }),
        el('button', { class: 'btn btn-secondary', type: 'button', text: 'Abandon', onclick: () => closeTask(t.id, 'abandon') }));
    }
    return el('div', {}, kids);
  }

  function createRow(t) {
    return el('tr', { '--i': t.i },
      el('td', {}, el('code', { text: t.id })),
      el('td', {}, t.title),
      el('td', {}, t.team),
      el('td', {}, t.lead),
      el('td', {}, originChip(t)),
      el('td', { 'data-f': 'permission' }, permissionChip(t)),
      el('td', { 'data-f': 'status' }, statusChip(t.status)),
      el('td', { 'data-f': 'turns', text: turnsText(t) }),
      el('td', {}, el('span', { class: 'dim', text: (t.createdAt || '').slice(0, 19) })),
      el('td', { 'data-f': 'actions' }, actionsFor(t)));
  }

  // Only the fields that can actually change after a task is opened: its
  // permission posture (the operator can flip security.unattendedExec
  // between loads), status, turn count, and the actions available for that
  // status. slackChannel/slackThreadTs (origin) never change once set.
  function updateRow(tr, t) {
    tr.querySelector('[data-f="permission"]').replaceChildren(permissionChip(t));
    tr.querySelector('[data-f="status"]').replaceChildren(statusChip(t.status));
    tr.querySelector('[data-f="turns"]').textContent = turnsText(t);
    tr.querySelector('[data-f="actions"]').replaceChildren(actionsFor(t));
  }

  async function load() {
    try {
      const arr = await api('/tasks');
      clear(postureBanner);
      if (arr.length === 0) {
        show(el('div', { class: 'empty' },
          'No tasks yet. Run ', el('code', { text: 'lazyclaw task start --team X --title "..."' }), '.'));
        return;
      }
      if (arr.some((t) => !t.attended)) {
        postureBanner.append(banner('warn', '!', el('b', { text: 'Some tasks arrived from a channel and ran read-only. ' }),
          'An inbound surface has no human watching it, so it fails closed until ',
          el('code', { text: 'security.unattendedExec = true' }), '.'));
      }
      if (shown !== tableWrap) show(tableWrap);
      reconcile(tbody, arr.map((t, i) => ({ ...t, i })), (t) => t.id, createRow, updateRow);
    } catch (e) {
      show(el('div', { class: 'empty', text: 'Error: ' + e.message }));
    }
  }

  async function closeTask(id, action) {
    if (!confirm(`${action === 'done' ? 'Mark done' : 'Abandon'} task ${id}?`)) return;
    try { await api(`/tasks/${encodeURIComponent(id)}/${action}`, { method: 'POST' }); load(); }
    catch (e) { alert(`${action} failed: ` + e.message); }
  }

  await load();
}
