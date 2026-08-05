// web/ui/panels/sessions.mjs — persisted chat sessions: list, view transcript,
// export as markdown, delete.
import { el, phead } from '../dom.mjs';
import { api, apiRaw } from '../api.mjs';
import { openModal, closeModal } from '../modal.mjs';

export async function render(host) {
  host.append(phead('Sessions', 'Persisted chat sessions.'));
  let list = el('div', { class: 'empty', text: 'Loading…' });
  host.append(list);

  async function load() {
    try {
      const r = await api('/sessions?withV5=true');
      const arr = r.sessions || r;
      if (!Array.isArray(arr) || arr.length === 0) {
        list.replaceWith(list = el('div', { class: 'empty' },
          'No persisted sessions yet. Start one with ',
          el('code', { text: 'lazyclaw chat --session <id>' }), '.'));
        return;
      }
      const rows = arr.map((s) => {
        const id = s.id || s.sessionId || s.name || JSON.stringify(s);
        const turns = s.turns ?? s.turnCount ?? '';
        const updated = s.updatedAt || s.mtime || '';
        // v5 columns: trainerHandled / agentName / trajectoryId.
        const tagTrained = s.trainerHandled
          ? el('span', { class: 'pill ok', title: `trained by ${s.trainedBy || 'trainer'}`, text: `trained: ${s.trainedBy || 'on'}` })
          : null;
        const tagAgent = s.agentName
          ? el('span', { class: 'pill', style: 'background:rgba(217,179,90,0.18);color:var(--accent);', text: '@' + s.agentName })
          : null;
        const div = el('div', { class: 'card row clickable' },
          el('div', { class: 'name', text: id }),
          el('div', { class: 'dim', text: turns ? turns + ' turns' : '' }),
          tagTrained, tagAgent,
          el('div', { class: 'dim row-actions', text: updated }),
          el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'View', onclick: (e) => { e.stopPropagation(); openSessionDetail(id); } }),
          el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Export', onclick: (e) => { e.stopPropagation(); openSessionExport(id); } }),
          el('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Delete', onclick: (e) => { e.stopPropagation(); deleteSession(id); } }));
        div.addEventListener('click', () => openSessionDetail(id));
        return div;
      });
      list.replaceWith(list = el('div', {}, rows));
    } catch (e) {
      list.replaceWith(list = el('div', { class: 'empty', text: '⚠ ' + e.message }));
    }
  }

  async function openSessionDetail(id) {
    openModal({ title: `Session — ${id}`, body: el('div', { class: 'empty', text: 'Loading…' }) });
    try {
      const r = await api('/sessions/' + encodeURIComponent(id));
      const turns = r.turns || r.entries || r;
      if (!Array.isArray(turns) || turns.length === 0) {
        openModal({ title: `Session — ${id}`, body: el('div', { class: 'empty', text: 'Empty session.' }) });
        return;
      }
      const body = turns.map((t) => {
        const role = (t.role || 'note').toLowerCase();
        const content = String(t.content ?? t.text ?? '');
        const ts = t.ts || t.timestamp || '';
        return el('div', { class: 'turn ' + role },
          el('span', { class: 'role-tag', text: role + (ts ? ' · ' + ts : '') }), content);
      });
      openModal({ title: `Session — ${id}`, body });
    } catch (e) {
      openModal({ title: `Session — ${id}`, body: el('div', { class: 'empty', text: '⚠ ' + e.message }) });
    }
  }

  async function openSessionExport(id) {
    openModal({ title: `Export — ${id}`, body: el('div', { class: 'empty', text: 'Loading…' }) });
    try {
      const r = await apiRaw('/sessions/' + encodeURIComponent(id) + '/export?format=md');
      const text = await r.text();
      openModal({
        title: `Export — ${id}`,
        body: el('pre', { text }),
        foot: [
          el('button', {
            class: 'btn btn-secondary', type: 'button', text: 'Copy markdown',
            onclick: (e) => {
              navigator.clipboard.writeText(text);
              e.target.textContent = 'Copied!';
              setTimeout(() => { e.target.textContent = 'Copy markdown'; }, 1200);
            },
          }),
          el('button', { class: 'btn', type: 'button', text: 'Close', onclick: () => closeModal() }),
        ],
      });
    } catch (e) {
      openModal({ title: `Export — ${id}`, body: el('div', { class: 'empty', text: '⚠ ' + e.message }) });
    }
  }

  async function deleteSession(id) {
    if (!confirm(`Delete session "${id}"?\nTurn log will be permanently removed.`)) return;
    try {
      // api() throws on a non-ok status; apiRaw does not, and fetch itself only
      // rejects on a network failure — so the old apiRaw call reported success
      // for a 403 or a 500 and the user was told a delete happened that had not.
      await api('/sessions/' + encodeURIComponent(id), { method: 'DELETE' });
      load();
    } catch (e) {
      alert('Delete failed: ' + e.message);
    }
  }

  await load();
}
