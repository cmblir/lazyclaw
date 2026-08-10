// web/ui/panels/workflows.mjs — workflow run sessions: filterable list with
// aggregate stats, a per-session detail modal (node table), run/resume/clear.
// Writes go through the slash dispatcher (runSlashConfirmed +
// slash_actions.mjs), same grammar a user would type in the REPL — not a
// typed REST call. /workflow run|resume|clear (tui/slash_workflow.mjs, Task
// 14) operates on STORED named workflows (cfg.workflows[name]); the name is
// also the sessionId once a workflow has run at least once, so it is the
// same identifier this panel already lists rows by.
import { el, phead, table, banner } from '../dom.mjs';
import { api } from '../api.mjs';
import { openModal } from '../modal.mjs';
import { reconcile } from '../reconcile.mjs';
import { runSlashConfirmed } from '../confirm_dialog.mjs';
import { workflowRun, workflowResume, workflowClear } from '../slash_actions.mjs';

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

export function render(host) {
  host.append(phead('Workflows', null));

  const statusSel = el('select', {},
    el('option', { value: '', text: 'all' }),
    el('option', { value: 'running', text: 'running' }),
    el('option', { value: 'resumable', text: 'resumable' }),
    el('option', { value: 'failed', text: 'failed' }),
    el('option', { value: 'done', text: 'done' }));
  const filterInput = el('input', { type: 'search', placeholder: 'filter by id substring' });
  const meta = el('span', { class: 'dim' });
  host.append(el('div', { class: 'toolbar' },
    el('button', { class: 'btn', type: 'button', text: '+ Run workflow', onclick: () => openRunModal() }),
    statusSel, filterInput,
    el('button', { class: 'btn btn-secondary', type: 'button', text: 'Refresh', onclick: () => load() }),
    meta));
  // Cleared on every load() and every write attempt; holds the one error
  // banner for whichever write just failed (never for a cancellation).
  const errorBox = el('div', {});
  host.append(errorBox);

  let grid = el('div', { class: 'grid' });
  host.append(grid);

  // Shared by run/resume/clear — see web/ui/panels/agents.mjs's runWrite for
  // the full rationale (truthy `out.ok` check, CANCELLED is silent, hint
  // appended). A refused run (e.g. "workflow not found") is exactly as real
  // a failure as a network error and must not refresh as though it worked.
  //
  // Takes a thunk, not an already-composed line, so a composer throw lands
  // inside this function instead of becoming an unhandled rejection before
  // runWrite ever starts.
  async function runWrite(compose) {
    errorBox.replaceChildren();
    let line;
    try {
      line = compose();
    } catch (e) {
      errorBox.replaceChildren(banner('err', '✗', e.message || String(e)));
      return;
    }
    const out = await runSlashConfirmed(line);
    if (out.ok) { load(); return; }
    if (out.code === 'CANCELLED') return;
    const msg = out.hint ? `${out.error || 'failed'} — ${out.hint}` : (out.error || 'failed');
    errorBox.replaceChildren(banner('err', '✗', msg));
  }

  // /workflow run <name> only works against a name stored under
  // cfg.workflows — guide the flow the same way teams.mjs does for its own
  // create modal, rather than letting the operator type a name that /workflow
  // will just refuse as "workflow not found".
  async function openRunModal() {
    let names = [];
    try { const cfg = await api('/config'); names = Object.keys(cfg.workflows || {}); } catch { /* fall through with empty list */ }
    if (names.length === 0) {
      alert('No stored workflows configured yet — add one under cfg.workflows (see docs) before running it from here.');
      return;
    }
    const name = (prompt(`Workflow (one of ${names.join(', ')}):`, names[0]) || '').trim();
    if (!name) return;
    await runWrite(() => workflowRun(name));
  }

  // The sessions table shell is built once; reconcile() only touches the
  // fields that change on a re-fetch (state pills, counts, updated time),
  // so a Refresh no longer discards every session row's node and re-plays
  // its entrance animation.
  const tbody = el('tbody', {});
  const tableWrap = el('div', { class: 'scroll' }, el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {}, ['Session', 'State', 'Done / Total', 'Failed', 'Updated', ''].map((h) => el('th', { text: h })))),
    tbody));

  let list = el('div', { class: 'empty', text: 'Loading…' });
  host.append(list);
  function showList(node) { list.replaceWith(list = node); }

  function tagsFor(sm) {
    const tags = [];
    if (sm.running > 0) tags.push(el('span', { class: 'pill warn', text: 'running' }));
    if (sm.failed > 0) tags.push(el('span', { class: 'pill err', text: 'failed' }));
    if (sm.resumable) tags.push(el('span', { class: 'pill warn', text: 'resumable' }));
    if (sm.done) tags.push(el('span', { class: 'pill ok', text: 'done' }));
    return tags.length ? tags : [el('span', { class: 'dim', text: '—' })];
  }

  // Resume only offered when the session itself reports resumable — Clear
  // (== /workflow clear, a confirmed destructive action, see
  // daemon/lib/slash_destructive.mjs) is always available, matching the old
  // Delete button's reach.
  function actionsFor(s) {
    const sm = s.summary || {};
    const kids = [];
    if (sm.resumable) {
      kids.push(el('button', {
        class: 'btn btn-secondary btn-sm', type: 'button', text: 'Resume',
        onclick: (e) => { e.stopPropagation(); runWrite(() => workflowResume(s.sessionId)); },
      }));
    }
    kids.push(el('button', {
      class: 'btn btn-danger btn-sm', type: 'button', text: 'Clear',
      onclick: (e) => { e.stopPropagation(); runWrite(() => workflowClear(s.sessionId)); },
    }));
    return el('div', {}, kids);
  }

  function createRow(s) {
    const sm = s.summary || {};
    const tr = el('tr', { class: 'clickable', '--i': s.i },
      el('td', {}, el('code', { text: s.sessionId })),
      el('td', { 'data-f': 'tags' }, tagsFor(sm)),
      el('td', { class: 'num', 'data-f': 'counts', text: `${sm.success ?? 0} / ${sm.total ?? ''}` }),
      el('td', { class: 'num', 'data-f': 'failed', text: String(sm.failed ?? 0) }),
      el('td', { class: 'dim', 'data-f': 'updated', text: s.updatedAt || s.startedAt || '' }),
      el('td', { 'data-f': 'actions' }, actionsFor(s)));
    tr.addEventListener('click', () => openWorkflowDetail(s.sessionId));
    return tr;
  }

  // Only the fields a re-fetch can actually change: state, done/total,
  // failed count, updated timestamp, and now the actions available (Resume
  // depends on the freshly-fetched `resumable` flag). sessionId and the
  // click handler are fixed for the life of a session, so the row itself
  // never needs to be rebuilt.
  function updateRow(tr, s) {
    const sm = s.summary || {};
    tr.querySelector('[data-f="tags"]').replaceChildren(...tagsFor(sm));
    tr.querySelector('[data-f="counts"]').textContent = `${sm.success ?? 0} / ${sm.total ?? ''}`;
    tr.querySelector('[data-f="failed"]').textContent = String(sm.failed ?? 0);
    tr.querySelector('[data-f="updated"]').textContent = s.updatedAt || s.startedAt || '';
    tr.querySelector('[data-f="actions"]').replaceChildren(actionsFor(s));
  }

  let debounceTimer = null;
  statusSel.addEventListener('change', () => load());
  filterInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => load(), 250);
  });

  async function load() {
    errorBox.replaceChildren();
    // Only show the transient placeholder when there's nothing on screen
    // yet — once the table is up, a Refresh reconciles it in place instead
    // of flashing back to "Loading…" and losing every row's node for that.
    if (list !== tableWrap) showList(el('div', { class: 'empty', text: 'Loading…' }));
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
        showList(el('div', { class: 'empty' },
          'No workflow runs yet. Click + Run workflow above (for a stored, named workflow), ',
          'or run an ad hoc one with ', el('code', { text: 'pompos run <id> ./flow.mjs' }), '.'));
        return;
      }
      if (list !== tableWrap) showList(tableWrap);
      reconcile(tbody, sessions.map((s, i) => ({ ...s, i })), (s) => s.sessionId, createRow, updateRow);
    } catch (e) {
      showList(el('div', { class: 'empty', text: '⚠ ' + e.message }));
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

  // render() must return its cleanup synchronously — shell.mjs's activate()
  // now handles an async render's Promise-wrapped cleanup correctly too, but
  // there's nothing here that needs the initial load() awaited before the
  // panel is usable, so keep this the simple shape.
  load(); // fire-and-forget; failures render inline via the catch above
  return () => clearTimeout(debounceTimer);
}
