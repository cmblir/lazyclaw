// web/ui/panels/trainer.mjs — read-only trainer status. Learning runs
// automatically after each completed agent task; there is no manual sync.
import { el, phead, kvlist } from '../dom.mjs';
import { api } from '../api.mjs';

export async function render(host) {
  const meta = el('span', { class: 'dim' });
  host.append(phead('Trainer', null));
  host.append(el('div', { class: 'toolbar' },
    el('button', { class: 'btn btn-secondary', type: 'button', text: 'Refresh', onclick: () => load() }),
    meta));
  let card = el('div', { class: 'empty', text: 'Loading…' });
  host.append(card);

  async function load() {
    try {
      const r = await api('/trainer/status');
      meta.textContent = r.lastRunAt ? `last run ${new Date(r.lastRunAt).toLocaleString()}` : 'no runs recorded';
      const pct = (r.budget && r.callsToday != null) ? Math.min(100, Math.round((r.callsToday / r.budget) * 100)) : null;
      card.replaceWith(card = el('div', {},
        el('div', { class: 'card' }, kvlist([
          ['Provider', r.provider || '—', true],
          ['Model', r.model || '—', true],
          ['Schedule', r.schedule || 'off', true],
          ['Recipe', r.recipe || 'inherit', true],
          ['Calls today', String(r.callsToday ?? 0) + (r.budget ? ` / ${r.budget} (${pct}%)` : ''), true],
        ])),
        el('p', {
          class: 'dim', style: 'margin-top:10px;font-size:13px;line-height:1.4;max-width:60ch;',
          text: 'Learning runs automatically after each completed agent task — trajectories are distilled into skills using the trainer provider above. There is no manual sync.',
        })));
    } catch (e) {
      card.replaceWith(card = el('div', { class: 'empty', text: '⚠ ' + e.message }));
    }
  }

  await load();
}
