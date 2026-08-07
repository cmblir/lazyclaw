// web/ui/panels/skills.mjs — installed skills, grouped, with curator
// suggestions, a detail modal (raw markdown body), delete, and synthesize
// a new skill from a session id.
import { el, phead } from '../dom.mjs';
import { api, apiRaw, apiSoft } from '../api.mjs';
import { openModal, closeModal } from '../modal.mjs';

// v5 confidence pill color: red <0.4, amber <0.7, green >=0.7.
function confidencePill(c) {
  if (c == null || c === '') return null;
  const n = Number(c);
  if (!Number.isFinite(n)) return null;
  const cls = n >= 0.7 ? 'ok' : (n >= 0.4 ? 'warn' : 'err');
  return el('span', { class: 'pill ' + cls, title: 'confidence', text: n.toFixed(2) });
}

export async function render(host) {
  const meta = el('span', { class: 'dim' });
  host.append(phead('Skills', null));
  host.append(el('div', { class: 'toolbar' },
    el('button', { class: 'btn btn-secondary', type: 'button', text: 'Refresh', onclick: () => load() }),
    meta));
  let suggBox = el('div', {});
  host.append(suggBox);
  let list = el('div', { class: 'empty', text: 'Loading…' });
  host.append(list);

  function loadSuggestions() {
    apiSoft('/skills/suggestions').then(({ body }) => {
      const items = (body && body.suggestions) || [];
      if (!items.length) { suggBox.replaceChildren(); return; }
      suggBox.replaceWith(suggBox = el('div', { class: 'card', style: 'border-color:var(--accent);' },
        el('div', { class: 'name', style: 'color:var(--accent);', text: `Curator suggestions (${items.length})` }),
        items.slice(0, 5).map((s) => el('div', { class: 'dim', style: 'margin-top:6px;font-size:12px;' },
          s.suggestion || s.cluster?.sample || '',
          el('span', { class: 'dim', style: 'margin-left:6px;', text: s.ts ? new Date(s.ts).toLocaleString() : '' })))));
    }).catch(() => { suggBox.replaceChildren(); });
  }

  function skillCard(s) {
    const crossOk = Array.isArray(s.cross_cli_tested) && s.cross_cli_tested.length
      ? el('span', { class: 'pill ok', title: 'cross-CLI: ' + s.cross_cli_tested.map((x) => x.provider || '').join(', '), text: 'x-cli ✓' })
      : (s.cross_cli_tested === true
        ? el('span', { class: 'pill ok', title: 'cross-CLI tested', text: 'x-cli ✓' })
        : el('span', { class: 'pill', title: 'not cross-CLI tested', style: 'opacity:0.4;', text: 'x-cli —' }));
    const div = el('div', { class: 'card clickable' },
      el('div', { class: 'row', style: 'border:0;padding:0;' },
        el('div', { class: 'name', text: s.name }),
        s.trained_by ? el('span', { class: 'pill', title: 'trained_by', text: s.trained_by }) : null,
        confidencePill(s.confidence), crossOk,
        el('div', { class: 'dim row-actions', text: `${s.bytes ?? ''} bytes` }),
        el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'View', onclick: (e) => { e.stopPropagation(); openSkillDetail(s.name); } }),
        el('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Delete', onclick: (e) => { e.stopPropagation(); deleteSkill(s.name); } })),
      el('div', { class: 'dim', style: 'margin-top:6px;', text: s.summary || s.description || '' }));
    div.addEventListener('click', () => openSkillDetail(s.name));
    return div;
  }

  async function load() {
    loadSuggestions();
    try {
      const r = await api('/skills');
      const arr = r.skills || r;
      if (!Array.isArray(arr) || arr.length === 0) {
        list.replaceWith(list = el('div', { class: 'empty' },
          'No skills yet. Install one: ', el('code', { text: 'pompos skills install <user>/<repo>' }), '.'));
        meta.textContent = '';
        return;
      }
      meta.textContent = `${arr.length} skill${arr.length === 1 ? '' : 's'}`;
      const groups = new Map();
      for (const s of arr) {
        const g = (s.group && String(s.group)) || 'ungrouped';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(s);
      }
      const groupNames = [...groups.keys()].sort();
      const sections = groupNames.map((g) => el('div', { style: 'margin-top:12px;' },
        el('h3', { style: 'font-size:13px;color:var(--dim);margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.05em;', text: `${g} · ${groups.get(g).length}` }),
        groups.get(g).map(skillCard)));
      const synthResult = el('span', { class: 'dim' });
      const synthInput = el('input', { type: 'text', placeholder: 'sessionId to synthesize', style: 'flex:1;min-width:200px;' });
      const synthBar = el('div', { class: 'toolbar', style: 'margin-top:14px;' },
        synthInput,
        el('button', { class: 'btn', type: 'button', text: 'Synthesize from task', onclick: () => skillSynth(synthInput, synthResult) }),
        synthResult);
      list.replaceWith(list = el('div', {}, sections, synthBar));
    } catch (e) {
      list.replaceWith(list = el('div', { class: 'empty', text: '⚠ ' + e.message }));
    }
  }

  async function skillSynth(input, out) {
    const sid = (input.value || '').trim();
    if (!sid) { out.style.color = 'var(--warn)'; out.textContent = 'enter a sessionId'; return; }
    out.style.color = 'var(--dim)';
    out.textContent = '⏳ synthesizing…';
    try {
      const r = await apiRaw('/skills/synth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sid }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok) {
        out.style.color = 'var(--ok)';
        out.textContent = '✓ ' + (body.name ? `created skill "${body.name}"` : (body.message || 'done'));
        load();
      } else {
        out.style.color = 'var(--err)';
        out.textContent = '✗ ' + (body.error || r.statusText);
      }
    } catch (e) {
      out.style.color = 'var(--err)';
      out.textContent = '✗ ' + e.message;
    }
  }

  async function openSkillDetail(name) {
    openModal({ title: `Skill — ${name}`, body: el('div', { class: 'empty', text: 'Loading…' }) });
    try {
      // GET /skills/<name> returns the markdown body as text/markdown.
      const r = await apiRaw('/skills/' + encodeURIComponent(name));
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const text = await r.text();
      openModal({
        title: `Skill — ${name}`,
        body: el('pre', { class: 'markdown', text }),
        foot: [
          el('button', {
            class: 'btn btn-secondary', type: 'button', text: 'Copy',
            onclick: (e) => {
              navigator.clipboard.writeText(text);
              e.target.textContent = 'Copied!';
              setTimeout(() => { e.target.textContent = 'Copy'; }, 1200);
            },
          }),
          el('button', { class: 'btn', type: 'button', text: 'Close', onclick: () => closeModal() }),
        ],
      });
    } catch (e) {
      openModal({ title: `Skill — ${name}`, body: el('div', { class: 'empty', text: '⚠ ' + e.message }) });
    }
  }

  async function deleteSkill(name) {
    if (!confirm(`Remove skill "${name}"?`)) return;
    // api() throws on a non-ok status; apiRaw returned the Response and this
    // discarded it, so a failed removal was reported to the user as done.
    try { await api('/skills/' + encodeURIComponent(name), { method: 'DELETE' }); load(); }
    catch (e) { alert('Delete failed: ' + e.message); }
  }

  await load();
}
