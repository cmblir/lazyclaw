// web/ui/panels/agents.mjs — registered agents: list, create (prompt-driven,
// provider/model optional), delete. Writes go through the slash dispatcher
// (runSlashConfirmed + slash_actions.mjs), same grammar a user would type in
// the REPL — not a typed REST call.
import { el, phead, table, banner } from '../dom.mjs';
import { api } from '../api.mjs';
import { runSlashConfirmed } from '../confirm_dialog.mjs';
import { agentCreate, agentRemove } from '../slash_actions.mjs';

// Provider ids the REPL onboarding wizard offers, mirrored here so the
// prompt below shows the same options rather than a bare free-text field.
const PROVIDER_HINT = 'anthropic / openai / gemini / claude-cli';

export async function render(host) {
  const meta = el('span', { class: 'dim' });
  host.append(phead('Agents', null));
  host.append(el('div', { class: 'toolbar' },
    el('button', { class: 'btn', type: 'button', text: '+ New agent', onclick: () => openAgentModal() }),
    el('button', { class: 'btn btn-secondary', type: 'button', text: 'Refresh', onclick: () => load() }),
    meta));
  // Cleared on every load() and every write attempt; holds the one error
  // banner for whichever write just failed (never for a cancellation).
  const errorBox = el('div', {});
  host.append(errorBox);
  let list = el('div', { class: 'empty', text: 'Loading…' });
  host.append(list);

  // Shared by create/remove: success reloads the list, a cancelled confirm
  // does nothing (no error, no reload — the user said no), and any other
  // failure shows the reason (plus the NEEDS_TERMINAL hint, if present) and
  // leaves the list exactly as it was. `out.ok` is checked for truthiness,
  // not `=== true`/`=== false`: a 401 body is {error:'unauthorized'} with
  // no `ok` field at all, and that must read as "did not happen", not as
  // neither success nor failure.
  //
  // Takes a thunk, not an already-composed line. A composer (agentCreate)
  // can throw — an embedded `"` has no safe encoding on this grammar, see
  // arg() in slash_actions.mjs — and that throw has to land INSIDE this
  // function to be shown as a failure. `runWrite(agentCreate(...))` would
  // evaluate the composer before runWrite ever starts, turning the throw
  // into an unhandled rejection: no banner, no refresh, silence. A thunk
  // puts the one guard in the one place every call site shares, instead of
  // requiring each call site to remember its own try/catch.
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
        actions: el('button', { class: 'btn btn-secondary', type: 'button', text: 'Delete', onclick: () => runWrite(() => agentRemove(a.name)) }),
      }));
      list.replaceWith(list = table(
        [{ key: 'name', label: 'name' }, { key: 'provider', label: 'provider/model' },
         { key: 'tools', label: 'tools' }, { key: 'role', label: 'role (excerpt)' }, { key: 'actions', label: '' }],
        rows,
      ));
      // data-agent is a test hook only (no behaviour change) — table() has no
      // per-row attribute param, so rows are tagged after the fact, in the
      // same order they were built.
      list.querySelectorAll('tbody tr').forEach((tr, i) => tr.setAttribute('data-agent', arr[i].name));
    } catch (e) {
      list.replaceWith(list = el('div', { class: 'empty', text: 'Error: ' + e.message }));
    }
  }

  // /agent add <name> [--provider <p>] [--model <m>] [role] (Task 14 added
  // the flags; --tools is still not settable here — that remains narrower
  // than the REST call this replaced, see task-8-report.md). Leaving either
  // prompt blank omits the flag, so the agent keeps the dispatcher's default
  // provider — same as typing `/agent add <name>` with no flags at all.
  async function openAgentModal() {
    const name = (prompt('Agent name (e.g. planner, backend, frontend):') || '').trim();
    if (!name) return;
    const provider = (prompt(`Provider (${PROVIDER_HINT}) — blank keeps the default:`) || '').trim();
    const model = (prompt('Model id (blank = provider default):') || '').trim();
    const role = prompt('Role / system prompt (optional):') || '';
    await runWrite(() => agentCreate({ name, role, provider, model }));
  }

  await load();
}
