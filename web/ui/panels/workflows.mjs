// web/ui/panels/workflows.mjs — workflow run sessions: filterable list with
// aggregate stats, a per-session detail modal (node table), and delete.
import { el, phead, table } from '../dom.mjs';
import { api, apiRaw } from '../api.mjs';
import { openModal } from '../modal.mjs';

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
  host.append(phead('Workflows', null));

  const statusSel = el('select', {},
    el('option', { value: '', text: 'all' }),
    el('option', { value: 'running', text: 'running' }),
    el('option', { value: 'resumable', text: 'resumable' }),
    el('option', { value: 'failed', text: 'failed' }),
    el('option', { value: 'done', text: 'done' }));
  const filterInput = el('input', { type: 'search', placeholder: 'filter by id substring' });
  const meta = el('span', { class: 'dim' });
  host.append(el('div', { class: 'toolbar' }, statusSel, filterInput,
    el('button', { class: 'btn btn-secondary', type: 'button', text: 'Refresh', onclick: () => load() }),
    meta));

  let grid = el('div', { class: 'grid' });
  host.append(grid);
  let list = el('div', { class: 'empty', text: 'Loading…' });
  host.append(list);

  let debounceTimer = null;
  statusSel.addEventListener('change', () => load());
  filterInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => load(), 250);
  });

  async function load() {
    list.replaceWith(list = el('div', { class: 'empty', text: 'Loading…' }));
    grid.replaceChildren();
    try {
      const status = statusSel.value;
      const filter = filterInput.value.trim();
      const qs = new URLSearchParams();
      if (status) qs.set('status', status);
      if (filter) qs.set('filter', filter);
      const url = '/workflows' + (qs.toString() ? '?' + qs : '');
      const [r, agg] = await Promise.all([api(url), api('/workflows/aggregate').catch(() => null)]);
      const sessions = r.sessions || [];
      meta.textContent = `${sessions.length} session${sessions.length === 1 ? '' : 's'} · dir ${r.dir || '?'}`;
      const counts = sessions.reduce((acc, s) => {
        const sm = s.summary || {};
        if (sm.done) acc.done++;
        if (sm.resumable) acc.resumable++;
        if (sm.failed > 0) acc.failed++;
        if (sm.running > 0) acc.running++;
        return acc;
      }, { done: 0, resumable: 0, failed: 0, running: 0 });
      grid.replaceChildren(
        el('div', { class: 'stat' }, el('div', { class: 'label', text: 'Total' }), el('div', { class: 'value', text: String(sessions.length) })),
        el('div', { class: 'stat' }, el('div', { class: 'label', text: 'Running' }), el('div', { class: 'value', text: String(counts.running) })),
        el('div', { class: 'stat' }, el('div', { class: 'label', text: 'Resumable' }), el('div', { class: 'value', text: String(counts.resumable) })),
        el('div', { class: 'stat' }, el('div', { class: 'label', text: 'Failed' }, ), el('div', { class: 'value', style: counts.failed ? 'color:var(--err);' : '', text: String(counts.failed) })),
        el('div', { class: 'stat' }, el('div', { class: 'label', text: 'Done' }), el('div', { class: 'value', style: counts.done ? 'color:var(--ok);' : '', text: String(counts.done) })),
        agg && agg.sessionCount != null
          ? el('div', { class: 'stat' }, el('div', { class: 'label', text: 'Aggregate sessions' }),
              el('div', { class: 'value', text: String(agg.sessionCount) }),
              el('div', { class: 'sub', text: `${Object.keys(agg.nodeStats || {}).length} distinct nodes` }))
          : null,
      );
      if (sessions.length === 0) {
        list.replaceWith(list = el('div', { class: 'empty' },
          'No workflow runs yet. Run one with ', el('code', { text: 'lazyclaw run <id> ./flow.mjs' }), '.'));
        return;
      }
      const rows = sessions.map((s, i) => {
        const sm = s.summary || {};
        const tags = [];
        if (sm.running > 0) tags.push(el('span', { class: 'pill warn', text: 'running' }));
        if (sm.failed > 0) tags.push(el('span', { class: 'pill err', text: 'failed' }));
        if (sm.resumable) tags.push(el('span', { class: 'pill warn', text: 'resumable' }));
        if (sm.done) tags.push(el('span', { class: 'pill ok', text: 'done' }));
        const tr = el('tr', { class: 'clickable', '--i': i },
          el('td', {}, el('code', { text: s.sessionId })),
          el('td', {}, tags.length ? tags : el('span', { class: 'dim', text: '—' })),
          el('td', { class: 'num', text: `${sm.success ?? 0} / ${sm.total ?? ''}` }),
          el('td', { class: 'num', text: String(sm.failed ?? 0) }),
          el('td', { class: 'dim', text: s.updatedAt || s.startedAt || '' }),
          el('td', {}, el('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Delete', onclick: (e) => { e.stopPropagation(); deleteWorkflow(s.sessionId); } })));
        tr.addEventListener('click', () => openWorkflowDetail(s.sessionId));
        return tr;
      });
      list.replaceWith(list = el('div', { class: 'scroll' },
        el('table', { class: 'tbl' },
          el('thead', {}, el('tr', {}, ['Session', 'State', 'Done / Total', 'Failed', 'Updated', ''].map((h) => el('th', { text: h })))),
          el('tbody', {}, rows))));
    } catch (e) {
      list.replaceWith(list = el('div', { class: 'empty', text: '⚠ ' + e.message }));
    }
  }

  async function openWorkflowDetail(id) {
    openModal({ title: `Workflow — ${id}`, body: el('div', { class: 'empty', text: 'Loading…' }) });
    try {
      const r = await api('/workflows/' + encodeURIComponent(id));
      const sm = r.summary || {};
      // GET /workflows/<id> returns the per-node map under `nodes`.
      const nodes = r.nodes || r.state?.nodes || {};
      const nodeRows = Object.entries(nodes).map(([nid, n]) => {
        const status = (n.status || '').toLowerCase();
        const pillClass = status === 'failed' ? 'err' : (status === 'success' ? 'ok' : (status === 'running' ? 'warn' : ''));
        const dur = n.durationMs != null ? fmtDuration(n.durationMs) : '—';
        const out = String(n.output ?? n.error ?? '');
        const truncated = out.length > 240 ? out.slice(0, 240) + '…' : out;
        return { node: el('code', { text: nid }), status: pillClass ? el('span', { class: 'pill ' + pillClass, text: status }) : (status || '—'), dur, out: el('span', { class: 'dim', text: truncated }) };
      });
      const summary = el('div', { class: 'grid', style: 'margin-bottom:14px;' },
        el('div', { class: 'stat' }, el('div', { class: 'label', text: 'Total' }), el('div', { class: 'value', text: String(sm.total ?? '—') })),
        el('div', { class: 'stat' }, el('div', { class: 'label', text: 'Done' }), el('div', { class: 'value', text: String(sm.success ?? 0) })),
        el('div', { class: 'stat' }, el('div', { class: 'label', text: 'Failed' }), el('div', { class: 'value', style: sm.failed ? 'color:var(--err);' : '', text: String(sm.failed ?? 0) })),
        el('div', { class: 'stat' }, el('div', { class: 'label', text: 'Running' }), el('div', { class: 'value', text: String(sm.running ?? 0) })));
      const body = nodeRows.length
        ? [summary, table(
            [{ key: 'node', label: 'Node' }, { key: 'status', label: 'Status' }, { key: 'dur', label: 'Duration', class: 'num' }, { key: 'out', label: 'Output / Error' }],
            nodeRows,
          )]
        : [summary, el('div', { class: 'empty', text: 'No node results yet.' })];
      openModal({ title: `Workflow — ${id}`, body });
    } catch (e) {
      openModal({ title: `Workflow — ${id}`, body: el('div', { class: 'empty', text: '⚠ ' + e.message }) });
    }
  }

  async function deleteWorkflow(id) {
    if (!confirm(`Delete workflow session "${id}"?\nState file will be permanently removed.`)) return;
    try {
      await apiRaw('/workflows/' + encodeURIComponent(id), { method: 'DELETE' });
      load();
    } catch (e) {
      alert('Delete failed: ' + e.message);
    }
  }

  await load();
  return () => clearTimeout(debounceTimer);
}
