// web/ui/panels/teams.mjs — registered teams: list, create (prompt-driven,
// guided by the already-registered agent names), member add/remove,
// delete. Writes go through the slash dispatcher (runSlashConfirmed +
// slash_actions.mjs), same grammar a user would type in the REPL — not a
// typed REST call.
import { el, phead, table, banner } from '../dom.mjs';
import { api } from '../api.mjs';
import { runSlashConfirmed } from '../confirm_dialog.mjs';
import { teamCreate, teamRemove, teamMemberAdd, teamMemberRemove } from '../slash_actions.mjs';

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

  // Shared by create/member-add/member-remove/remove — see agents.mjs's
  // runWrite for the full rationale (truthy `out.ok` check, CANCELLED is
  // silent, hint appended, and a thunk so a composer throw — e.g. an
  // embedded `"` — lands inside this function instead of becoming an
  // unhandled rejection before it's ever called).
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
        // Each member is removable in place — /team member remove <team>
        // <agent> (Task 14) — rather than only being editable by recreating
        // the whole team.
        agents: (t.agents || []).length
          ? el('div', {}, (t.agents || []).map((a) => el('span', { class: 'chip' }, a,
              el('button', {
                class: 'btn btn-secondary btn-sm', type: 'button', text: '×',
                title: `remove ${a} from ${t.name}`,
                onclick: () => runWrite(() => teamMemberRemove(t.name, a)),
              }))))
          : el('span', { class: 'dim', text: '(none)' }),
        slack: t.slackChannel ? el('code', { text: t.slackChannel }) : el('span', { class: 'dim', text: '(none)' }),
        actions: el('div', {},
          el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: '+ Member', onclick: () => addMember(t.name) }),
          // data-action is a test hook only (no behaviour change).
          el('button', { class: 'btn btn-secondary', type: 'button', text: 'Delete', 'data-action': 'team-remove', onclick: () => runWrite(() => teamRemove(t.name)) })),
      }));
      list.replaceWith(list = table(
        [{ key: 'name', label: 'name' }, { key: 'lead', label: 'lead' }, { key: 'agents', label: 'agents' },
         { key: 'slack', label: 'slack channel' }, { key: 'actions', label: '' }],
        rows,
      ));
      // data-team is a test hook only (no behaviour change) — table() has no
      // per-row attribute param, so rows are tagged after the fact, in the
      // same order they were built.
      list.querySelectorAll('tbody tr').forEach((tr, i) => tr.setAttribute('data-team', arr[i].name));
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
    await runWrite(() => teamCreate({ name, agents, lead, channel }));
  }

  async function addMember(teamName) {
    let registered = [];
    try { registered = (await api('/agents')).map((a) => a.name); } catch { /* fall through with empty list */ }
    if (registered.length === 0) {
      alert('Create an agent first (Agents tab → + New agent) before adding it to a team.');
      return;
    }
    const agentName = (prompt(`Add which agent to "${teamName}"? (registered: ${registered.join(', ')})`) || '').trim();
    if (!agentName) return;
    await runWrite(() => teamMemberAdd(teamName, agentName));
  }

  await load();
}
