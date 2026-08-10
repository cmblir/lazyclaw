// web/ui/slash_actions.mjs — panel buttons compose the exact line a user
// would type. The grammar lives here, tested, rather than being
// concatenated inside five DOM modules where a drifting variant would go
// unnoticed.
//
// Every line below was checked against the real handler
// (tui/slash_dispatcher.mjs, tui/slash_team.mjs, tui/slash_workflow.mjs,
// tui/config_picker.mjs) rather than assumed.
//
// Task 8 originally shipped without teamMemberAdd/Remove and
// workflowRun/Resume/Clear: no backing command existed for any of them (see
// git history). The user ruled the dispatcher should be extended rather than
// the dashboard shipping narrower or making a typed REST call — Task 14
// added `/team member add|remove` and `/workflow run|resume|clear`, and
// `--provider`/`--model` on `/agent add`. All five composers below are
// restored against that real, tested grammar.

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
//
// Fix round: every interpolated value in this file goes through arg() now,
// not just the ones that "looked" free-text. Two gaps a review found:
// agentCreate's `role` was concatenated raw (a quote in it silently
// vanished instead of being rejected — worse than throwing, since the line
// still "worked" and saved the wrong role) and teamCreate's `agents` list
// was joined without it. Names/ids are slug-like in practice, so wrapping
// them costs nothing (arg() only quotes on whitespace, and only throws on
// an actual embedded `"`) — but the guard should not depend on a reviewer
// noticing which call sites "look" risky.
function arg(value) {
  const s = String(value ?? '');
  if (s.includes('"')) {
    throw new Error('value cannot contain a literal " character — the slash tokenizer has no escape for it');
  }
  return /\s/.test(s) ? `"${s}"` : s;
}

// /agent add <name> [--provider <p>] [--model <m>] [role text…] —
// tui/slash_dispatcher.mjs's `_agent` handler (sub === 'add'). Flags are
// optional and additive (Task 14); everything else after the name is
// free-form role text, in whatever order it appears relative to the flags —
// putting the flags first keeps the role text contiguous and easy to read.
export function agentCreate({ name, role, provider, model } = {}) {
  let line = `/agent add ${arg(req(name, 'agent name'))}`;
  if (provider) line += ` --provider ${arg(provider)}`;
  if (model) line += ` --model ${arg(model)}`;
  const r = String(role ?? '').trim();
  return r ? `${line} ${arg(r)}` : line;
}
export function agentRemove(name) { return `/agent remove ${arg(req(name, 'agent name'))}`; }

// /team add <name> --agents a,b[,c] [--lead x] [--channel #x] — matches
// tui/slash_dispatcher.mjs's `_team` handler (sub === 'add') exactly,
// including --channel, which the pre-existing dashboard create flow
// already collects (dropping it here would be a regression).
export function teamCreate({ name, agents, lead, channel } = {}) {
  let line = `/team add ${arg(req(name, 'team name'))}`;
  if (agents && agents.length) line += ` --agents ${agents.map((a) => arg(a)).join(',')}`;
  if (lead) line += ` --lead ${arg(lead)}`;
  if (channel) line += ` --channel ${arg(channel)}`;
  return line;
}
export function teamRemove(name) { return `/team remove ${arg(req(name, 'team name'))}`; }

// /team member add|remove <team> <agent> — tui/slash_team.mjs's `member`
// branch (Task 14). Positional, in that exact order; the dispatcher rejects
// any other action verb with a usage error.
export function teamMemberAdd(team, agent) {
  return `/team member add ${arg(req(team, 'team name'))} ${arg(req(agent, 'agent name'))}`;
}
export function teamMemberRemove(team, agent) {
  return `/team member remove ${arg(req(team, 'team name'))} ${arg(req(agent, 'agent name'))}`;
}

// /task start <team> --title "..." — `_task`'s `start` handler only
// recognises --title/--description/--lead; a bare positional title after
// the team name is silently dropped (not an error), so the line always
// fails usage. --title is required here for that reason.
export function taskIssue({ team, title } = {}) {
  return `/task start ${arg(req(team, 'team name'))} --title ${arg(req(title, 'task title'))}`;
}
export function taskAbandon(id) { return `/task abandon ${arg(req(id, 'task id'))}`; }
// /task done <id> — the same `_task` branch as abandon (sub === 'done'),
// added so "Mark done" does not stay on a typed REST call while its
// sibling "Abandon" moves to the slash grammar.
export function taskDone(id) { return `/task done ${arg(req(id, 'task id'))}`; }

export function configSet(key, value) { return `/config set ${arg(req(key, 'config key'))} ${arg(value)}`; }
export function configUnset(key) { return `/config unset ${arg(req(key, 'config key'))}`; }

// /workflow run|resume|clear <name> — tui/slash_workflow.mjs (Task 14). Runs
// a STORED, declarative workflow (cfg.workflows[name]) through the
// persisted engine keyed by sessionId=name; a second run resumes. `name` is
// therefore both the config key under cfg.workflows and the workflow
// panel's sessionId once it has run at least once — the same identifier the
// panel already lists rows by.
export function workflowRun(name) { return `/workflow run ${arg(req(name, 'workflow name'))}`; }
export function workflowResume(name) { return `/workflow resume ${arg(req(name, 'workflow name'))}`; }
export function workflowClear(name) { return `/workflow clear ${arg(req(name, 'workflow name'))}`; }
