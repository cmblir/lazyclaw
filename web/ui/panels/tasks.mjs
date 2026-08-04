// web/ui/panels/tasks.mjs — read-mostly task list with done/abandon actions.
// Tasks are created via the CLI (`lazyclaw task start`), not from here.
import { el, phead, table } from '../dom.mjs';
import { api } from '../api.mjs';

export async function render(host) {
  host.append(phead('Tasks', 'Tasks are created via lazyclaw task start.'));
  const list = el('div', { class: 'empty', text: 'Loading…' });
  host.append(list);

  async function load() {
    try {
      const arr = await api('/tasks');
      if (arr.length === 0) {
        list.replaceWith(list = el('div', { class: 'empty' },
          'No tasks yet. Run ', el('code', { text: 'lazyclaw task start --team X --title "..."' }), '.'));
        return;
      }
      const rows = arr.map((t) => ({
        id: el('code', { text: t.id }),
        title: t.title,
        team: t.team,
        lead: t.lead,
        status: el('span', { class: 'status status-' + t.status, text: t.status }),
        turns: String(Array.isArray(t.turns) ? t.turns.length : 0),
        opened: el('span', { class: 'dim', text: (t.createdAt || '').slice(0, 19) }),
        actions: (t.status === 'running' || t.status === 'pending' || t.status === 'paused')
          ? el('div', {},
              el('button', { class: 'btn btn-secondary', type: 'button', text: 'Mark done', onclick: () => closeTask(t.id, 'done') }),
              el('button', { class: 'btn btn-secondary', type: 'button', text: 'Abandon', onclick: () => closeTask(t.id, 'abandon') }))
          : null,
      }));
      list.replaceWith(list = table(
        [{ key: 'id', label: 'id' }, { key: 'title', label: 'title' }, { key: 'team', label: 'team' },
         { key: 'lead', label: 'lead' }, { key: 'status', label: 'status' }, { key: 'turns', label: 'turns' },
         { key: 'opened', label: 'opened' }, { key: 'actions', label: '' }],
        rows,
      ));
    } catch (e) {
      list.replaceWith(list = el('div', { class: 'empty', text: 'Error: ' + e.message }));
    }
  }

  async function closeTask(id, action) {
    if (!confirm(`${action === 'done' ? 'Mark done' : 'Abandon'} task ${id}?`)) return;
    try { await api(`/tasks/${encodeURIComponent(id)}/${action}`, { method: 'POST' }); load(); }
    catch (e) { alert(`${action} failed: ` + e.message); }
  }

  await load();
}
