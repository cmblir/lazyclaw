// web/ui/panels/agents.mjs — registered agents: list, create (prompt-driven),
// delete. Kept minimal (parity with the CLI, not polish) — same as it was.
import { el, phead, table } from '../dom.mjs';
import { api } from '../api.mjs';

export async function render(host) {
  const meta = el('span', { class: 'dim' });
  host.append(phead('Agents', null));
  host.append(el('div', { class: 'toolbar' },
    el('button', { class: 'btn', type: 'button', text: '+ New agent', onclick: () => openAgentModal() }),
    el('button', { class: 'btn btn-secondary', type: 'button', text: 'Refresh', onclick: () => load() }),
    meta));
  let list = el('div', { class: 'empty', text: 'Loading…' });
  host.append(list);

  async function load() {
    try {
      const arr = await api('/agents');
      meta.textContent = `${arr.length} agent(s)`;
      if (arr.length === 0) {
        list.replaceWith(list = el('div', { class: 'empty', text: 'No agents yet — click + New agent to create one.' }));
        return;
      }
      const rows = arr.map((a) => ({
        name: el('div', {}, el('strong', { text: a.name }), el('br'), el('span', { class: 'dim', text: a.displayName || '' })),
        provider: a.model ? `${a.provider}/${a.model}` : a.provider,
        tools: (a.tools || []).map((t) => el('code', { text: t })),
        role: a.role ? el('span', { text: a.role.slice(0, 60) + (a.role.length > 60 ? '…' : '') }) : el('span', { class: 'dim', text: '(none)' }),
        actions: el('button', { class: 'btn btn-secondary', type: 'button', text: 'Delete', onclick: () => deleteAgent(a.name) }),
      }));
      list.replaceWith(list = table(
        [{ key: 'name', label: 'name' }, { key: 'provider', label: 'provider/model' },
         { key: 'tools', label: 'tools' }, { key: 'role', label: 'role (excerpt)' }, { key: 'actions', label: '' }],
        rows,
      ));
    } catch (e) {
      list.replaceWith(list = el('div', { class: 'empty', text: 'Error: ' + e.message }));
    }
  }

  async function openAgentModal() {
    const name = (prompt('Agent name (e.g. planner, backend, frontend):') || '').trim();
    if (!name) return;
    const role = prompt('Role / system prompt (optional):') || '';
    const provider = (prompt('Provider (anthropic / openai / gemini / claude-cli):', 'anthropic') || 'anthropic').trim();
    const model = (prompt('Model id (blank = provider default):') || '').trim();
    const toolsRaw = (prompt('Tools (comma-separated):', 'bash,read,write,grep') || '').trim();
    const tools = toolsRaw ? toolsRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    try {
      await api('/agents', { method: 'POST', body: JSON.stringify({ name, role, provider, model, tools }) });
      load();
    } catch (e) {
      alert('Create failed: ' + e.message);
    }
  }

  async function deleteAgent(name) {
    if (!confirm(`Delete agent "${name}"?`)) return;
    try { await api(`/agents/${encodeURIComponent(name)}`, { method: 'DELETE' }); load(); }
    catch (e) { alert('Delete failed: ' + e.message); }
  }

  await load();
}
