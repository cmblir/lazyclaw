// web/ui/panels/sandbox.mjs — sandbox backend profiles: test connectivity,
// switch the active backend.
import { el, phead } from '../dom.mjs';
import { api, apiRaw } from '../api.mjs';

export async function render(host) {
  const meta = el('span', { class: 'dim' });
  host.append(phead('Sandbox', null));
  host.append(el('div', { class: 'toolbar' },
    el('button', { class: 'btn btn-secondary', type: 'button', text: 'Refresh', onclick: () => load() }),
    meta));
  let list = el('div', { class: 'empty', text: 'Loading…' });
  host.append(list);

  async function load() {
    try {
      const r = await api('/sandbox');
      const profiles = r.profiles || [];
      meta.textContent = `active: ${r.active || 'local'}`;
      if (!profiles.length) {
        list.replaceWith(list = el('div', { class: 'empty', text: 'No sandbox profiles configured.' }));
        return;
      }
      const cards = profiles.map((p) => {
        const isActive = p.name === r.active;
        const out = el('div', { class: 'dim', style: 'margin-top:6px;font-size:11px;' });
        const card = el('div', { class: 'card' },
          el('div', { class: 'row', style: 'border:0;padding:0;' },
            el('div', { class: 'name', text: p.name }),
            isActive ? el('span', { class: 'pill ok', text: 'active' }) : null,
            p.configured ? null : el('span', { class: 'pill warn', text: 'unconfigured' }),
            el('div', { class: 'dim row-actions', text: p.summary || '' }),
            el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Test', onclick: () => sandboxTest(p.name, out) }),
            isActive ? null : el('button', { class: 'btn btn-sm', type: 'button', text: 'Use', onclick: () => sandboxUse(p.name) })),
          out);
        return card;
      });
      list.replaceWith(list = el('div', {}, cards));
    } catch (e) {
      list.replaceWith(list = el('div', { class: 'empty', text: '⚠ ' + e.message }));
    }
  }

  async function sandboxTest(name, out) {
    out.textContent = '⏳ testing…';
    out.style.color = 'var(--dim)';
    try {
      const r = await apiRaw('/sandbox/' + encodeURIComponent(name) + '/test', { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (body.ok) {
        out.style.color = 'var(--ok)';
        out.textContent = `✓ ok · ${body.durationMs || '?'}ms · ${String(body.stdout || '').slice(0, 80)}`;
      } else {
        out.style.color = 'var(--err)';
        out.textContent = `✗ ${body.error || 'failed'}`;
      }
    } catch (e) {
      out.style.color = 'var(--err)';
      out.textContent = '✗ ' + e.message;
    }
  }

  async function sandboxUse(name) {
    try {
      const r = await apiRaw('/sandbox/use', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
      if (!r.ok) { const e = await r.json().catch(() => ({})); alert('Failed: ' + (e.error || r.statusText)); return; }
      load();
    } catch (e) { alert('Failed: ' + e.message); }
  }

  await load();
}
