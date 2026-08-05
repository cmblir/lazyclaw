// web/ui/panels/metrics.mjs — request/cache/token/cost counters from
// GET /metrics.
import { el, phead } from '../dom.mjs';
import { api } from '../api.mjs';

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

export async function render(host) {
  const meta = el('span', { class: 'dim' });
  host.append(phead('Metrics', null));
  host.append(el('div', { class: 'toolbar' },
    el('button', { class: 'btn btn-secondary', type: 'button', text: 'Refresh', onclick: () => load() }),
    meta));
  let cards = el('div', { class: 'grid' });
  host.append(cards);
  let detail = el('div', { class: 'empty', text: 'Loading…' });
  host.append(detail);

  async function load() {
    cards.replaceChildren();
    try {
      const m = await api('/metrics');
      meta.textContent = m.timestamp ? new Date(m.timestamp).toLocaleString() : '';
      const cache = m.cache || { hits: 0, misses: 0, size: 0 };
      const totalCache = (cache.hits || 0) + (cache.misses || 0);
      const hitRate = totalCache > 0 ? ((cache.hits / totalCache) * 100).toFixed(1) + '%' : '—';
      const tokens = m.tokensTotal || {};
      const tokIn = tokens.inputTokens || tokens.input || tokens.in || 0;
      const tokOut = tokens.outputTokens || tokens.output || tokens.out || 0;
      const wf = m.workflows || {};
      const costPairs = Object.entries(m.costsByCurrency || {});
      const costStr = costPairs.length ? costPairs.map(([cur, n]) => `${n.toFixed(4)} ${cur}`).join(' · ') : '—';
      cards.replaceChildren(
        el('div', { class: 'stat' }, el('div', { class: 'label', text: 'Uptime' }), el('div', { class: 'value', text: fmtDuration(m.uptimeMs) })),
        el('div', { class: 'stat' }, el('div', { class: 'label', text: 'Requests' }), el('div', { class: 'value', text: String(m.requestsTotal ?? 0) }), el('div', { class: 'sub', text: `denied ${m.rateLimitDenied ?? 0}` })),
        el('div', { class: 'stat' }, el('div', { class: 'label', text: 'Cache hit rate' }), el('div', { class: 'value', text: hitRate }), el('div', { class: 'sub', text: `${cache.hits || 0} hits / ${cache.misses || 0} misses · ${cache.size || 0} entries` })),
        el('div', { class: 'stat' }, el('div', { class: 'label', text: 'Tokens (in / out)' }), el('div', { class: 'value', text: `${tokIn.toLocaleString()} / ${tokOut.toLocaleString()}` })),
        el('div', { class: 'stat' }, el('div', { class: 'label', text: 'Cost' }), el('div', { class: 'value', style: 'font-size:16px;', text: costStr })),
        wf && wf.total != null
          ? el('div', { class: 'stat' }, el('div', { class: 'label', text: 'Workflows' }), el('div', { class: 'value', text: String(wf.total) }), el('div', { class: 'sub', text: `${wf.running || 0} running · ${wf.failed || 0} failed · ${wf.done || 0} done` }))
          : null,
      );
      const byStatus = m.requestsByStatus || {};
      const statusKeys = Object.keys(byStatus).sort();
      detail.replaceWith(detail = el('div', { class: 'card' },
        el('div', { class: 'dim', style: 'margin-bottom:6px;', text: 'Requests by status' }),
        statusKeys.length
          ? el('table', { class: 'tbl' },
              el('thead', {}, el('tr', {}, el('th', { text: 'Status' }), el('th', { text: 'Count' }))),
              el('tbody', {}, statusKeys.map((s) => el('tr', {}, el('td', { text: s }), el('td', { class: 'num', text: String(byStatus[s]) })))))
          : el('div', { class: 'empty', text: 'No requests served yet.' })));
    } catch (e) {
      detail.replaceWith(detail = el('div', { class: 'empty', text: '⚠ ' + e.message }));
    }
  }

  await load();
}
