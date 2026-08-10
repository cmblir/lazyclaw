// tui/slash_workflow.mjs — the /workflow slash-command handler.
//
// Task 8 needed a slash surface for running/resuming/clearing a workflow and
// settled on a single-token grammar (workflowRun(name)/workflowResume(name) in
// web/ui/slash_actions.mjs compose exactly `/workflow run|resume <name>`).
// commands/workflow.mjs's dispatch() — what this task's brief points at — does
// implement run/resume/clear, but needs a sessionId AND a workflow-file path
// for run/resume, and every branch ends in process.exit() after a
// console.log/error: calling it from here would take down whichever process
// (daemon or Ink REPL) hosts this dispatcher on the very first /workflow call,
// and it does not fit a single <name> token anyway.
//
// What DOES fit a single name, is real capability that already ships, and
// never touches process.exit/console — the same primitive
// POST /workflows/run already uses (daemon/routes/workflows.mjs) — is a
// STORED declarative workflow (cfg.workflows[<name>], workflow/named.mjs) run
// through the persisted engine keyed by sessionId=<name>. A second call with
// the same id resumes (workflow/run_request.mjs's runDeclarativePersistent
// doc comment), which gives "resume" a real backing without inventing one.
// "clear" mirrors commands/workflow.mjs's cmdClear / daemon/routes/
// workflows.mjs's workflowDelete exactly, minus the process.exit.
import fs from 'node:fs';
import { splitWhitespace } from './slash_helpers.mjs';
import { getNamedWorkflow, runNamedWorkflow, namedReplyText } from '../workflow/named.mjs';
import { loadState, statePath, DEFAULT_DIR } from '../workflow/persistent.mjs';
import { PROVIDERS } from '../providers/registry.mjs';

// Same fallback the daemon (commands/daemon.mjs) and the CLI engine
// (commands/workflow.mjs) already use — CWD-relative, not cfgDir-relative;
// workflow state has never been scoped to the operator's config directory.
function stateDir() {
  return process.env.POMPOS_WORKFLOW_STATE_DIR || DEFAULT_DIR;
}

// Sync, not async — run_request.mjs's _capsFromConfig calls this WITHOUT
// awaiting it, so an async lookup here would hand it a Promise instead of a
// provider and silently starve every llm-node of its provider.
const providerLookup = (name) => PROVIDERS[name] || null;

export async function _workflow(args, ctx) {
  const [sub, name] = splitWhitespace(String(args || '').trim());
  if (!/^(run|resume|clear)$/.test(sub || '')) {
    return 'usage: /workflow run|resume|clear <name>';
  }
  if (!name) return `usage: /workflow ${sub} <name>`;
  const dir = stateDir();

  if (sub === 'clear') {
    let p;
    try { p = statePath(name, dir); }
    catch (e) { return `workflow clear failed: ${e?.message || e}`; }
    const existed = fs.existsSync(p);
    if (existed) fs.unlinkSync(p);
    return existed
      ? `✓ cleared saved progress for workflow ${name}`
      : `workflow ${name}: no saved progress to clear`;
  }

  const cfg = ctx.cfg || {};
  const entry = getNamedWorkflow(cfg, name);
  if (!entry) return `workflow not found: ${name}`;

  if (sub === 'resume' && !loadState(name, dir)) {
    return `workflow ${name}: no run in progress to resume — start it with /workflow run ${name}`;
  }

  try {
    const result = await runNamedWorkflow(name, cfg, { sessionId: name, dir, providerLookup });
    if (!result.success) {
      return `workflow ${name} ${sub} failed: ${result.error || 'unknown error'}${result.failedAt ? ` (at ${result.failedAt})` : ''}`;
    }
    const reply = namedReplyText(result, entry);
    const preview = reply ? ` — ${String(reply).replace(/\s+/g, ' ').slice(0, 160)}` : '';
    return `✓ workflow ${name} ${sub} (${(result.executedNodes || []).length} node(s))${preview}`;
  } catch (e) {
    return `workflow ${name} ${sub} failed: ${e?.message || e}`;
  }
}
