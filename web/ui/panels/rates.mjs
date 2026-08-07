// web/ui/panels/rates.mjs — cost-per-token rate cards: list (with filter and
// validation banner), add/edit modal, delete.
import { el, phead } from '../dom.mjs';
import { api, apiRaw, apiSoft } from '../api.mjs';
import { openModal, closeModal } from '../modal.mjs';

export function render(host) {
  const meta = el('span', { class: 'dim' });
  const filterInput = el('input', { type: 'search', placeholder: 'filter by provider/model' });
  host.append(phead('Rates', null));
  host.append(el('div', { class: 'toolbar' },
    el('button', { class: 'btn', type: 'button', text: '+ Add / edit rate card', onclick: () => openRateCardModal() }),
    filterInput,
    el('button', { class: 'btn btn-secondary', type: 'button', text: 'Refresh', onclick: () => load() }),
    meta));
  let validateBox = el('div', {});
  host.append(validateBox);
  let list = el('div', { class: 'empty', text: 'Loading…' });
  host.append(list);

  let debounceTimer = null;
  filterInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => load(), 250);
  });

  async function load() {
    validateBox.replaceChildren();
    try {
      const filter = filterInput.value.trim();
      const url = '/rates' + (filter ? '?filter=' + encodeURIComponent(filter) : '');
      const [rates, validate] = await Promise.all([api(url), apiSoft('/rates/validate')]);
      const entries = Object.entries(rates || {});
      meta.textContent = `${entries.length} card${entries.length === 1 ? '' : 's'}`;
      if (validate.body) {
        const v = validate.body;
        if (v.ok && !(v.warnings || []).length) {
          validateBox.replaceChildren(el('div', { class: 'banner ok', text: 'All rate cards valid.' }));
        } else {
          const items = [...(v.issues || []), ...(v.warnings || [])].map((i) => el('li', { text: typeof i === 'string' ? i : JSON.stringify(i) }));
          validateBox.replaceChildren(el('div', { class: 'banner ' + (v.ok ? 'warn' : 'err') },
            el('div', {}, el('strong', { text: v.ok ? 'Warnings' : 'Validation issues' }), el('ul', {}, items))));
        }
      }
      if (entries.length === 0) {
        list.replaceWith(list = el('div', { class: 'empty' },
          'No rate cards configured. Add one with ', el('code', { text: 'pompos rates set <provider/model> --in <usd> --out <usd>' }), '.'));
        return;
      }
      const rows = entries.map(([key, card]) => {
        const c = card || {};
        return el('tr', {},
          el('td', {}, el('code', { text: key })),
          el('td', { class: 'num', text: String(c.in ?? '—') }),
          el('td', { class: 'num', text: String(c.out ?? '—') }),
          el('td', { class: 'num', text: String(c['cache-read'] ?? '—') }),
          el('td', { class: 'num', text: String(c['cache-create'] ?? '—') }),
          el('td', { class: 'dim', text: `${c.currency || 'USD'} / 1M tok` }),
          el('td', {},
            el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Edit', onclick: () => openRateCardModal(key, c) }),
            el('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Delete', onclick: () => deleteRateCard(key) })));
      });
      list.replaceWith(list = el('table', { class: 'tbl' },
        el('thead', {}, el('tr', {}, ['Provider / Model', 'In', 'Out', 'Cache read', 'Cache create', 'Unit', ''].map((h) => el('th', { text: h })))),
        el('tbody', {}, rows)));
    } catch (e) {
      list.replaceWith(list = el('div', { class: 'empty', text: '⚠ ' + e.message }));
    }
  }

  function openRateCardModal(existingKey = '', existingCard = {}) {
    const c = existingCard || {};
    const status = el('div', { class: 'dim', style: 'font-size:12px;margin-top:8px;' });
    const keyInput = el('input', { placeholder: 'anthropic/claude-opus-4-7', value: existingKey, readonly: !!existingKey || null });
    const inInput = el('input', { type: 'number', step: '0.01', value: c.in ?? '' });
    const outInput = el('input', { type: 'number', step: '0.01', value: c.out ?? '' });
    const cacheReadInput = el('input', { type: 'number', step: '0.01', value: c['cache-read'] ?? '' });
    const cacheCreateInput = el('input', { type: 'number', step: '0.01', value: c['cache-create'] ?? '' });
    const currencyInput = el('input', { value: c.currency || 'USD' });
    openModal({
      title: existingKey ? `Edit rate card — ${existingKey}` : 'Add rate card',
      body: [
        el('div', { class: 'dim', style: 'margin-bottom:12px;font-size:12px;' },
          'Cost per 1M tokens (input / output / optional cache pricing). Same shape as ',
          el('code', { text: 'pompos rates set' }), '. Saving the same key overwrites the existing card.'),
        el('div', { class: 'form-row' }, el('label', { text: 'Provider / model key' }), keyInput),
        el('div', { class: 'grid', style: 'grid-template-columns:1fr 1fr;gap:10px;margin-bottom:0;' },
          el('div', { class: 'form-row' }, el('label', { text: 'Input (USD / 1M)' }), inInput),
          el('div', { class: 'form-row' }, el('label', { text: 'Output (USD / 1M)' }), outInput),
          el('div', { class: 'form-row' }, el('label', { text: 'Cache read (optional)' }), cacheReadInput),
          el('div', { class: 'form-row' }, el('label', { text: 'Cache create (optional)' }), cacheCreateInput),
          el('div', { class: 'form-row' }, el('label', { text: 'Currency' }), currencyInput)),
        status,
      ],
      foot: [
        el('button', { class: 'btn btn-secondary', type: 'button', text: 'Cancel', onclick: () => closeModal() }),
        el('button', {
          class: 'btn', type: 'button', text: 'Save',
          onclick: () => submitRateCard(keyInput, inInput, outInput, cacheReadInput, cacheCreateInput, currencyInput, status),
        }),
      ],
    });
  }

  async function submitRateCard(keyInput, inInput, outInput, cacheReadInput, cacheCreateInput, currencyInput, status) {
    const key = keyInput.value.trim();
    if (!key) { status.style.color = 'var(--err)'; status.textContent = 'Key is required.'; return; }
    const card = {
      in: parseFloat(inInput.value) || 0,
      out: parseFloat(outInput.value) || 0,
      currency: currencyInput.value.trim() || 'USD',
    };
    const cr = parseFloat(cacheReadInput.value);
    const cc = parseFloat(cacheCreateInput.value);
    if (Number.isFinite(cr)) card['cache-read'] = cr;
    if (Number.isFinite(cc)) card['cache-create'] = cc;
    status.style.color = 'var(--dim)';
    status.textContent = 'Saving…';
    try {
      const r = await apiRaw('/rates/' + encodeURIComponent(key), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(card),
      });
      const body = await r.json();
      if (!r.ok) {
        status.style.color = 'var(--err)';
        const issues = (body.issues || []).map((i) => (typeof i === 'string' ? i : JSON.stringify(i))).join('; ');
        status.textContent = `✗ ${body.error || issues || `${r.status} ${r.statusText}`}`;
        return;
      }
      status.style.color = 'var(--ok)';
      status.textContent = '✓ saved';
      setTimeout(() => { closeModal(); load(); }, 600);
    } catch (e) {
      status.style.color = 'var(--err)';
      status.textContent = '✗ ' + (e.message || String(e));
    }
  }

  async function deleteRateCard(key) {
    if (!confirm(`Delete rate card "${key}"?`)) return;
    try {
      const r = await apiRaw('/rates/' + encodeURIComponent(key), { method: 'DELETE' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `${r.status}`);
      }
      load();
    } catch (e) {
      alert('Delete failed: ' + e.message);
    }
  }

  // render() must return its cleanup synchronously — shell.mjs's activate()
  // now handles an async render's Promise-wrapped cleanup correctly too, but
  // there's nothing here that needs the initial load() awaited before the
  // panel is usable, so keep this the simple shape.
  load(); // fire-and-forget; failures render inline via the catch above
  return () => clearTimeout(debounceTimer);
}
