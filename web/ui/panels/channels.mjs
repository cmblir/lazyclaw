// web/ui/panels/channels.mjs — configured inbound channels (Slack, etc.):
// enabled/disabled state, bound agent, last inbound activity.
import { el, phead } from '../dom.mjs';
import { api } from '../api.mjs';

export async function render(host) {
  const meta = el('span', { class: 'dim' });
  host.append(phead('Channels', null));
  host.append(el('div', { class: 'toolbar' },
    el('button', { class: 'btn btn-secondary', type: 'button', text: 'Refresh', onclick: () => load() }),
    meta));
  let list = el('div', { class: 'empty', text: 'Loading…' });
  host.append(list);

  async function load() {
    try {
      const r = await api('/channels');
      const arr = r.channels || [];
      meta.textContent = `${arr.length} channel${arr.length === 1 ? '' : 's'}`;
      if (!arr.length) {
        list.replaceWith(list = el('div', { class: 'empty' },
          'No channels configured. Configure via ', el('code', { text: 'lazyclaw config set channels.<name> ...' }), '.'));
        return;
      }
      const cards = arr.map((c) => el('div', { class: 'card' },
        el('div', { class: 'row', style: 'border:0;padding:0;' },
          el('div', { class: 'name', text: c.name }),
          c.enabled ? el('span', { class: 'pill ok', text: 'enabled' }) : el('span', { class: 'pill warn', text: 'disabled' }),
          el('div', { class: 'dim row-actions' }, c.boundAgent ? 'agent: ' + c.boundAgent : el('span', { class: 'dim', text: 'no binding' }))),
        el('div', { class: 'dim', style: 'margin-top:6px;font-size:12px;' },
          'last inbound: ' + (c.lastInboundAt ? new Date(c.lastInboundAt).toLocaleString() : '—'))));
      list.replaceWith(list = el('div', {}, cards));
    } catch (e) {
      list.replaceWith(list = el('div', { class: 'empty', text: '⚠ ' + e.message }));
    }
  }

  await load();
}
