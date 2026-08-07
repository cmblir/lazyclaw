// web/ui/panels/scheduling.mjs — read-mostly view of the three CLI-owned
// scheduling surfaces (cron jobs, durable goals, loop runs). Only cron
// exposes a delete here (safe: it just unschedules); creating schedules
// stays in the CLI since this loopback daemon is unauthenticated.
import { el, phead } from '../dom.mjs';
import { api } from '../api.mjs';

export async function render(host) {
  const meta = el('span', { class: 'dim' });
  host.append(phead('Scheduling', null));
  host.append(el('div', { class: 'toolbar' },
    el('button', { class: 'btn btn-secondary', type: 'button', text: 'Refresh', onclick: () => load() }),
    meta));
  let list = el('div', { class: 'empty', text: 'Loading…' });
  host.append(list);

  function cronSection(cron) {
    if (!cron.length) {
      return el('div', { class: 'empty' }, 'No cron jobs. Add one with ', el('code', { text: 'pompos cron add' }), '.');
    }
    const rows = cron.map((j) => el('tr', {},
      el('td', {}, el('strong', { text: j.name })),
      el('td', {}, el('code', { text: j.schedule || '' })),
      el('td', { class: 'dim', text: (j.command || []).join(' ') }),
      el('td', {}, el('button', { class: 'btn btn-secondary', type: 'button', text: 'Delete', onclick: () => deleteCron(j.name) }))));
    return el('table', {}, el('thead', {}, el('tr', {}, ['name', 'schedule', 'command', ''].map((h) => el('th', { text: h })))), el('tbody', {}, rows));
  }

  function goalsSection(goals) {
    if (!goals.length) {
      return el('div', { class: 'empty' }, 'No goals. Add one with ', el('code', { text: 'pompos goal add' }), '.');
    }
    return goals.map((g) => el('div', { class: 'card' },
      el('div', { class: 'row', style: 'border:0;padding:0;' },
        el('div', { class: 'name', text: g.name }),
        el('span', { class: 'pill ' + (g.status === 'active' ? 'ok' : 'warn'), text: g.status || 'active' }),
        el('div', { class: 'dim row-actions' }, g.schedule ? el('span', {}, 'schedule: ', el('code', { text: g.schedule })) : el('span', { class: 'dim', text: 'no schedule' }))),
      g.description ? el('div', { class: 'dim', style: 'margin-top:6px;font-size:12px;', text: g.description }) : null));
  }

  function loopsSection(loops) {
    if (!loops.length) {
      return el('div', { class: 'empty' }, 'No loop runs. Start one with ', el('code', { text: 'pompos loop' }), '.');
    }
    return loops.map((l) => el('div', { class: 'card' },
      el('div', { class: 'row', style: 'border:0;padding:0;' },
        el('div', { class: 'name', text: l.id || '' }),
        el('span', { class: 'pill ' + (l.status === 'running' || l.status === 'completed' ? 'ok' : 'warn'), text: l.status || '' }),
        el('div', { class: 'dim row-actions', text: (l.provider ? l.provider : '') + (l.model ? ' · ' + l.model : '') })),
      l.prompt ? el('div', { class: 'dim', style: 'margin-top:6px;font-size:12px;', text: String(l.prompt).slice(0, 160) }) : null));
  }

  async function load() {
    try {
      const r = await api('/scheduling');
      const cron = r.cron || [], goals = r.goals || [], loops = r.loops || [];
      meta.textContent = `${cron.length} cron · ${goals.length} goal${goals.length === 1 ? '' : 's'} · ${loops.length} loop${loops.length === 1 ? '' : 's'}`;
      list.replaceWith(list = el('div', {},
        el('h3', { class: 'dim', style: 'margin:8px 0 4px;', text: 'Cron jobs' }), cronSection(cron),
        el('h3', { class: 'dim', style: 'margin:14px 0 4px;', text: 'Goals' }), goalsSection(goals),
        el('h3', { class: 'dim', style: 'margin:14px 0 4px;', text: 'Loops' }), loopsSection(loops)));
    } catch (e) {
      list.replaceWith(list = el('div', { class: 'empty', text: '⚠ ' + e.message }));
    }
  }

  async function deleteCron(name) {
    if (!confirm(`Delete cron job "${name}"? This unschedules it; re-add via the CLI.`)) return;
    try { await api('/cron/' + encodeURIComponent(name), { method: 'DELETE' }); load(); }
    catch (e) { alert('Delete failed: ' + e.message); }
  }

  await load();
}
