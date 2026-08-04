// web/ui/panels/doctor.mjs — config/provider sanity checks plus the v5 FTS5
// index integrity row and its rebuild action.
import { el, phead, banner } from '../dom.mjs';
import { apiRaw, apiSoft } from '../api.mjs';

export async function render(host) {
  const meta = el('span', { class: 'dim' });
  host.append(phead('Doctor', null));
  host.append(el('div', { class: 'toolbar' },
    el('button', { class: 'btn btn-secondary', type: 'button', text: 'Run', onclick: () => load() }),
    meta));
  let card = el('div', { class: 'empty', text: 'Running…' });
  host.append(card);

  async function load() {
    const r = await apiSoft('/doctor');
    const d = r.body || {};
    meta.textContent = d.timestamp ? new Date(d.timestamp).toLocaleString() : '';
    const issues = d.issues || [];
    const okBanner = d.ok
      ? banner('ok', '✓', el('strong', { text: 'All checks passed.' }))
      : banner('err', '✗', el('div', {},
          el('strong', { text: `${issues.length} issue${issues.length === 1 ? '' : 's'}:` }),
          el('ul', {}, issues.map((i) => el('li', { text: i })))));
    // v5 index integrity row.
    const idx = d.index || null;
    let idxRow = null;
    if (idx) {
      const rowCounts = idx.rowCounts ? Object.entries(idx.rowCounts).map(([k, v]) => `${k}=${v}`).join(' · ') : '';
      idxRow = el('div', { class: 'row' },
        el('div', { class: 'name', text: 'FTS5 index' }),
        el('div', { class: 'dim', style: 'margin-left:auto;' },
          el('span', { class: 'pill ' + (idx.ok ? 'ok' : 'err'), text: idx.ok ? 'ok' : 'degraded' }),
          ' ', el('span', { class: 'dim', text: rowCounts }),
          idx.ok ? null : el('button', { class: 'btn btn-danger btn-sm', type: 'button', style: 'margin-left:8px;', text: 'Rebuild', onclick: () => rebuildIndex() })));
    }
    // Not a kvlist: the API-key row needs a pill (not plain text) and the
    // index row needs an inline Rebuild button, so this card is built by
    // hand — same fields, same order as the pre-split markup.
    card.replaceWith(card = el('div', {}, okBanner,
      el('div', { class: 'card' },
        el('div', { class: 'row' }, el('div', { class: 'name', text: 'Provider' }), el('div', { class: 'dim', style: 'margin-left:auto;', text: d.provider || '—' })),
        el('div', { class: 'row' }, el('div', { class: 'name', text: 'Model' }), el('div', { class: 'dim', style: 'margin-left:auto;', text: d.model || '—' })),
        el('div', { class: 'row' }, el('div', { class: 'name', text: 'API key' }), el('div', { class: 'dim', style: 'margin-left:auto;' }, d.hasApiKey ? el('span', { class: 'pill ok', text: 'present' }) : el('span', { class: 'pill warn', text: 'none' }))),
        el('div', { class: 'row' }, el('div', { class: 'name', text: 'Node' }), el('div', { class: 'dim', style: 'margin-left:auto;', text: d.nodeVersion || '—' })),
        el('div', { class: 'row' }, el('div', { class: 'name', text: 'Platform' }), el('div', { class: 'dim', style: 'margin-left:auto;', text: d.platform || '—' })),
        idxRow,
        el('div', { class: 'row' }, el('div', { class: 'name', text: 'Known providers' }), el('div', { class: 'dim', style: 'margin-left:auto;', text: (d.knownProviders || []).join(' · ') || '—' })))));
  }

  async function rebuildIndex() {
    if (!confirm('Rebuild the FTS5 index? Recall is repopulated from the existing corpus — no stored data is lost.')) return;
    try {
      const r = await apiRaw('/index/rebuild', { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { alert('Rebuild failed: ' + (body.error || r.statusText)); return; }
      alert('Index rebuilt. Re-run Doctor to confirm.');
      load();
    } catch (e) {
      alert('Rebuild failed: ' + e.message);
    }
  }

  await load();
}
