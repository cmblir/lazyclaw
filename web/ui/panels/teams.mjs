// web/ui/panels/teams.mjs — registered teams: list, create (prompt-driven,
// guided by the already-registered agent names), delete. Writes go through
// the slash dispatcher (runSlashConfirmed + slash_actions.mjs), same
// grammar a user would type in the REPL — not a typed REST call.
import { el, phead, table, banner } from '../dom.mjs';
import { api } from '../api.mjs';
import { runSlashConfirmed } from '../confirm_dialog.mjs';
import { teamCreate, teamRemove } from '../slash_actions.mjs';

export async function render(host) {
  const meta = el('span', { class: 'dim' });
  host.append(phead('Teams', null));
  host.append(el('div', { class: 'toolbar' },
    el('button', { class: 'btn', type: 'button', text: '+ New team', onclick: () => openTeamModal() }),
    el('button', { class: 'btn btn-secondary', type: 'button', text: 'Refresh', onclick: () => load() }),
    meta));
  // Cleared on every load() and every write attempt; holds the one error
  // banner for whichever write just failed (never for a cancellation).
  const errorBox = el('div', {});
  host.append(errorBox);
  let list = el('div', { class: 'empty', text: 'Loading…' });
  host.append(list);

  // Shared by create/remove — see agents.mjs's runWrite for the full
  // rationale (truthy `out.ok` check, CANCELLED is silent, hint appended).
  async function runWrite(line) {
    errorBox.replaceChildren();
    const out = await runSlashConfirmed(line);
    if (out.ok) { load(); return; }
    if (out.code === 'CANCELLED') return;
    const msg = out.hint ? `${out.error || 'failed'} — ${out.hint}` : (out.error || 'failed');
    errorBox.replaceChildren(banner('err', '✗', msg));
  }

  async function load() {
    try {
      const arr = await api('/teams');
      meta.textContent = `${arr.length} team(s)`;
      if (arr.length === 0) {
        list.replaceWith(list = el('div', { class: 'empty', text: 'No teams yet — click + New team to create one.' }));
        return;
      }
      const rows = arr.map((t) => ({
        name: el('div', {}, el('strong', { text: t.name }), el('br'), el('span', { class: 'dim', text: t.displayName || '' })),
        lead: t.lead || '',
        agents: (t.agents || []).join(', '),
        slack: t.slackChannel ? el('code', { text: t.slackChannel }) : el('span', { class: 'dim', text: '(none)' }),
        actions: el('button', { class: 'btn btn-secondary', type: 'button', text: 'Delete', onclick: () => runWrite(teamRemove(t.name)) }),
      }));
      list.replaceWith(list = table(
        [{ key: 'name', label: 'name' }, { key: 'lead', label: 'lead' }, { key: 'agents', label: 'agents' },
         { key: 'slack', label: 'slack channel' }, { key: 'actions', label: '' }],
        rows,
      ));
    } catch (e) {
      list.replaceWith(list = el('div', { class: 'empty', text: 'Error: ' + e.message }));
    }
  }

  async function openTeamModal() {
    // A team can only reference agents already registered (the server
    // rejects unknown names) — guide the flow instead of letting the user
    // guess: bail early with a hint when there are none, pre-fill otherwise.
    let registered = [];
    try { registered = (await api('/agents')).map((a) => a.name); } catch { /* fall through with empty list */ }
    if (registered.length === 0) {
      alert('Create an agent first (Agents tab → + New agent). A team is built from agents you have already registered.');
      return;
    }
    const name = (prompt('Team name (e.g. shop, growth):') || '').trim();
    if (!name) return;
    const agentsRaw = (prompt(`Agents (comma-separated) — registered: ${registered.join(', ')}`, registered.join(', ')) || '').trim();
    if (!agentsRaw) return;
    const agents = agentsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    const lead = (prompt(`Lead (one of ${agents.join(', ')}):`, agents[0]) || agents[0]).trim();
    const channel = (prompt('Slack channel id or #name (optional):') || '').trim();
    await runWrite(teamCreate({ name, agents, lead, channel }));
  }

  await load();
}
