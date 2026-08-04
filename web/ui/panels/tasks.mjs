// web/ui/panels/tasks.mjs — read-mostly task list with done/abandon actions.
// Tasks are created via the CLI (`lazyclaw task start`), not from here.
import { el, phead } from '../dom.mjs';
import { api } from '../api.mjs';
import { reconcile } from '../reconcile.mjs';

// Same columns table() would have used — kept here so the header can be
// built once, up front, instead of every load().
const COLS = ['id', 'title', 'team', 'lead', 'status', 'turns', 'opened', ''];

function statusChip(status) {
  return el('span', { class: 'status status-' + status, text: status });
}

function turnsText(t) {
  return String(Array.isArray(t.turns) ? t.turns.length : 0);
}

export async function render(host) {
  host.append(phead('Tasks', 'Tasks are created via lazyclaw task start.'));

  // The table shell is built once; only its rows are reconciled per load(),
  // so an in-place status change no longer discards every other row's node.
  const tbody = el('tbody', {});
  const tableWrap = el('div', { class: 'scroll' }, el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {}, COLS.map((c) => el('th', { text: c })))), tbody));

  let shown = el('div', { class: 'empty', text: 'Loading…' });
  host.append(shown);
  function show(node) { shown.replaceWith(shown = node); }

  function actionsFor(t) {
    if (!(t.status === 'running' || t.status === 'pending' || t.status === 'paused')) return null;
    return el('div', {},
      el('button', { class: 'btn btn-secondary', type: 'button', text: 'Mark done', onclick: () => closeTask(t.id, 'done') }),
      el('button', { class: 'btn btn-secondary', type: 'button', text: 'Abandon', onclick: () => closeTask(t.id, 'abandon') }));
  }

  function createRow(t) {
    return el('tr', { '--i': t.i },
      el('td', {}, el('code', { text: t.id })),
      el('td', {}, t.title),
      el('td', {}, t.team),
      el('td', {}, t.lead),
      el('td', { 'data-f': 'status' }, statusChip(t.status)),
      el('td', { 'data-f': 'turns', text: turnsText(t) }),
      el('td', {}, el('span', { class: 'dim', text: (t.createdAt || '').slice(0, 19) })),
      el('td', { 'data-f': 'actions' }, actionsFor(t)));
  }

  // Only the fields that can actually change after a task is opened: its
  // status, turn count, and the actions available for that status.
  function updateRow(tr, t) {
    tr.querySelector('[data-f="status"]').replaceChildren(statusChip(t.status));
    tr.querySelector('[data-f="turns"]').textContent = turnsText(t);
    const acts = actionsFor(t);
    tr.querySelector('[data-f="actions"]').replaceChildren(...(acts ? [acts] : []));
  }

  async function load() {
    try {
      const arr = await api('/tasks');
      if (arr.length === 0) {
        show(el('div', { class: 'empty' },
          'No tasks yet. Run ', el('code', { text: 'lazyclaw task start --team X --title "..."' }), '.'));
        return;
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
