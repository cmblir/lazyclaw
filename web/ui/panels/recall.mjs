// web/ui/panels/recall.mjs — full-text search across sessions / skills /
// trajectories / memories (GET /recall?q=&scope=&k=).
import { el, phead, escHtml } from '../dom.mjs';
import { api } from '../api.mjs';
import { transcriptModal } from './tasks.mjs';

// appendTurn() (tasks.mjs) mirrors every task turn into the FTS index under
// session_id = `task:<id>`, so a hit's label can be `task:<id>` — optionally
// followed by a ` · turn N` disambiguator. Strip both so the id round-trips
// to GET /tasks/:id for the transcript modal.
function taskIdFromLabel(label) {
  const m = /^task:(.+?)(?:\s*·\s*turn\s+\d+)?$/i.exec(String(label || ''));
  return m ? m[1] : null;
}

export async function render(host) {
  host.append(phead('Recall', null));
  const q = el('input', { type: 'search', placeholder: 'search sessions / skills / trajectories / memories', style: 'flex:1;min-width:240px;' });
  const scope = el('select', {},
    el('option', { value: 'all', text: 'all scopes' }),
    el('option', { value: 'sessions', text: 'sessions' }),
    el('option', { value: 'skills', text: 'skills' }),
    el('option', { value: 'trajectories', text: 'trajectories' }),
    el('option', { value: 'memories', text: 'memories' }));
  const meta = el('span', { class: 'dim' });
  host.append(el('div', { class: 'toolbar' }, q, scope,
    el('button', { class: 'btn', type: 'button', text: 'Search', onclick: () => load() }),
    meta));
  let list = el('div', { class: 'empty', text: 'Enter a query above.' });
  host.append(list);

  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); load(); }
  });

  // Fetch the full task record (GET /tasks/:id decorates it with the same
  // attended/permissionMode fields the Tasks panel uses) and open the same
  // transcript modal Tasks does, so a `task:` hit links straight to it.
  async function openTaskTranscript(id) {
    try {
      const t = await api(`/tasks/${encodeURIComponent(id)}`);
      transcriptModal(t);
    } catch (e) {
      alert('Could not load task: ' + e.message);
    }
  }

  async function load() {
    const query = (q.value || '').trim();
    if (!query) { list.replaceWith(list = el('div', { class: 'empty', text: 'Enter a query above.' })); meta.textContent = ''; return; }
    list.replaceWith(list = el('div', { class: 'empty', text: 'Searching…' }));
    try {
      const qs = new URLSearchParams({ q: query });
      if (scope.value && scope.value !== 'all') qs.set('scope', scope.value);
      const r = await api('/recall?' + qs.toString());
      const hits = r.hits || [];
      meta.textContent = `${hits.length} hit${hits.length === 1 ? '' : 's'} · ${r.latencyMs?.toFixed(1) ?? '?'} ms`;
      if (!hits.length) { list.replaceWith(list = el('div', { class: 'empty', text: 'No matches.' })); return; }
      const cards = hits.map((h) => {
        const md = h.metadata || {};
        const label = md.session_id || md.skill_name || md.trajectory_id || md.topic || '—';
        const taskId = taskIdFromLabel(label);
        // The daemon wraps matched terms in <mark> inside an otherwise plain-text
        // snippet — escape everything, then restore just that one tag pair so
        // highlighting survives without opening up arbitrary HTML injection.
        const snippetHtml = escHtml(h.snippet || '')
          .replace(/&lt;mark&gt;/g, '<mark>').replace(/&lt;\/mark&gt;/g, '</mark>');
        const snippet = el('div', { class: 'dim', style: 'margin-top:6px;font-size:12px;' });
        snippet.innerHTML = snippetHtml;
        return el('div', { class: 'card' },
          el('div', { class: 'row', style: 'border:0;padding:0;' },
            el('span', { class: 'pill', style: 'background:rgba(217,179,90,0.18);color:var(--accent);', text: h.scope }),
            el('div', { class: 'name', style: 'margin-left:8px;', text: String(label) }),
            el('div', { class: 'dim row-actions' },
              el('span', { text: `bm25 ${Number(h.bm25 || 0).toFixed(2)}` }),
              taskId ? el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Open transcript', onclick: () => openTaskTranscript(taskId) }) : null)),
          snippet);
      });
      list.replaceWith(list = el('div', {}, cards));
    } catch (e) {
      list.replaceWith(list = el('div', { class: 'empty', text: '⚠ ' + e.message }));
    }
  }
}
