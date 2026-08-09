// web/ui/slash_actions.mjs — panel buttons compose the exact line a user
// would type. The grammar lives here, tested, rather than being
// concatenated inside five DOM modules where a drifting variant would go
// unnoticed.
//
// Every line below was checked against the real handler
// (tui/slash_dispatcher.mjs, tui/config_picker.mjs) rather than assumed.
// Three composers from the original draft did not survive that check and
// are intentionally absent — see the bottom of this file.

function req(value, what) {
  const s = String(value ?? '').trim();
  if (!s) throw new Error(`${what} is required`);
  return s;
}

// Quote only when needed, so a multi-word value survives the dispatcher's
// tokenizer (loop-engine.mjs's splitArgs) as one argument. That tokenizer
// has no escape mechanism at all — a `"` character only toggles its quote
// state — so a literal double quote inside a value cannot be represented
// on this grammar; embedding one would silently shift token boundaries for
// the rest of the line instead of failing loudly. Refuse instead.
function arg(value) {
  const s = String(value ?? '');
  if (s.includes('"')) {
    throw new Error('value cannot contain a literal " character — the slash tokenizer has no escape for it');
  }
  return /\s/.test(s) ? `"${s}"` : s;
}

// /agent add <name> [role text…] — tui/slash_dispatcher.mjs's `_agent`
// handler (sub === 'add') takes everything after the name as free-form
// role text (rest.slice(1).join(' ')); there is no --role or --model flag.
// A model can only be set afterward via `/agent edit <name>`, which opens
// an interactive picker (ctx.openPicker) that does not exist over HTTP —
// so it is not offered here.
export function agentCreate({ name, role } = {}) {
  const n = req(name, 'agent name');
  const r = String(role ?? '').trim();
  return r ? `/agent add ${n} ${r}` : `/agent add ${n}`;
}
export function agentRemove(name) { return `/agent remove ${req(name, 'agent name')}`; }

// /team add <name> --agents a,b[,c] [--lead x] [--channel #x] — matches
// tui/slash_dispatcher.mjs's `_team` handler (sub === 'add') exactly,
// including --channel, which the pre-existing dashboard create flow
// already collects (dropping it here would be a regression).
export function teamCreate({ name, agents, lead, channel } = {}) {
  let line = `/team add ${req(name, 'team name')}`;
  if (agents && agents.length) line += ` --agents ${agents.join(',')}`;
  if (lead) line += ` --lead ${arg(lead)}`;
  if (channel) line += ` --channel ${arg(channel)}`;
  return line;
}
export function teamRemove(name) { return `/team remove ${req(name, 'team name')}`; }

// /task start <team> --title "..." — `_task`'s `start` handler only
// recognises --title/--description/--lead; a bare positional title after
// the team name is silently dropped (not an error), so the line always
// fails usage. --title is required here for that reason.
export function taskIssue({ team, title } = {}) {
  return `/task start ${req(team, 'team name')} --title ${arg(req(title, 'task title'))}`;
}
export function taskAbandon(id) { return `/task abandon ${req(id, 'task id')}`; }
// /task done <id> — the same `_task` branch as abandon (sub === 'done'),
// added so "Mark done" does not stay on a typed REST call while its
// sibling "Abandon" moves to the slash grammar.
export function taskDone(id) { return `/task done ${req(id, 'task id')}`; }

export function configSet(key, value) { return `/config set ${req(key, 'config key')} ${arg(value)}`; }
export function configUnset(key) { return `/config unset ${req(key, 'config key')}`; }

// ─── Composers NOT implemented — no real command exists to back them ─────
//
// teamMemberAdd({team, agent}): `/team member …` does not exist.
// tui/slash_dispatcher.mjs's `_team` handler has exactly four subcommands
// — list, show, add, remove — and `add` refuses an existing name
// (teams.mjs's registerTeam throws TEAM_EXISTS). The one function that
// *can* add a member to an existing team, teams.mjs's patchTeam, is wired
// only to a typed REST route (PATCH /teams/:name, daemon/routes/registry.mjs)
// and the CLI — never to the slash dispatcher — so composing a line for it
// would either invent a non-existent command or require a typed REST call
// from a panel, both against this task's constraints.
//
// workflowRun(name) / workflowResume(name): `/workflow` is not in
// SLASH_HANDLERS (tui/slash_dispatcher.mjs) at all — the full table has no
// entry for "workflow", "run", or "resume" under any spelling. Workflow
// execution is a CLI-only surface (`pompos run <session> <file>` /
// `pompos resume <session>`, commands/workflow.mjs's dispatch()), entirely
// outside the REPL slash grammar the dashboard drives. workflows.mjs's own
// empty-state text already points operators at the CLI for this reason.
//
// Both gaps need a dispatcher change (a new `/team member` subcommand, a
// `/workflow run|resume` command or HTTP-reachable equivalent) before a
// dashboard button can compose a line for them without inventing a second
// grammar — out of scope for this task's file list. See task-8-report.md.
