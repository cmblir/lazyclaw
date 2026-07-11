// Workflow lifecycle commands (run / resume / inspect / clear / validate /
// graph), extracted from cli.mjs in Phase D3. Fully self-contained: depends
// only on node builtins and the workflow/ engine modules, no registry/config/
// TUI coupling. main() routes its six cases here through dispatch(cmd, rest).
import path from 'node:path';
import fs from 'node:fs';
// loadEngine/importWorkflow live in workflow_report.mjs (single definition,
// shared by both files); the read-only inspect/graph commands moved there to
// keep this file under the size ratchet.
import { loadEngine, importWorkflow, cmdInspect, cmdGraph } from './workflow_report.mjs';

// Wire SIGINT/SIGTERM to an AbortController so a workflow run aborts
// at the next node/level boundary (or sooner if execute() subscribed
// to the signal). Returns { signal, dispose } — the caller MUST call
// dispose() in a finally so we don't leak listeners across REPL turns.
//
// Exit-code semantics:
//   - normal success → 0
//   - normal failure → 1
//   - ABORT (signal-driven cancellation) → 130 (conventional Ctrl+C)
function makeRunSignal() {
  const ac = new AbortController();
  let received = null;
  const onSig = (sig) => {
    if (!received) {
      received = sig;
      ac.abort();
    } else {
      // Second signal: bail immediately without waiting for the engine.
      // Same "I really mean it" semantic the daemon uses.
      process.exit(130);
    }
  };
  const onSigint  = () => onSig('SIGINT');
  const onSigterm = () => onSig('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  return {
    signal: ac.signal,
    dispose() {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    },
    wasAborted() { return ac.signal.aborted; },
  };
}

function exitCodeFor(result, sig) {
  if (sig.wasAborted() || result?.code === 'ABORT' || result?.error?.code === 'ABORT') return 130;
  return result?.success ? 0 : 1;
}

async function cmdRun(sessionId, file, opts = {}) {
  const nodes = await importWorkflow(file);
  const dir = opts.dir || '.workflow-state';
  const sig = makeRunSignal();
  try {
    if (opts['parallel-persistent']) {
      // --parallel-persistent: DAG with checkpoint + resume. Same state
      // file shape as the sequential path so a session id collision is
      // observable, not silently corrupting.
      const { runPersistentDag } = await loadEngine();
      const r = await runPersistentDag(nodes, { sessionId, dir, timeoutMs: opts.timeoutMs, signal: sig.signal, concurrency: opts.concurrency });
      console.log(JSON.stringify({
        success: r.success,
        executedNodes: r.executedNodes || [],
        failedAt: r.failedAt || null,
        mode: 'parallel-persistent',
        aborted: r.code === 'ABORT' || sig.wasAborted() || undefined,
        error: r.error || null,
      }));
      process.exit(exitCodeFor(r, sig));
    }
    if (opts.parallel) {
      // --parallel: schedule by `deps`. No state persistence — `runParallel`
      // is a one-shot DAG run; resume semantics belong to runPersistent or
      // runPersistentDag. failedAt + executedNodes are derived from results
      // so the JSON shape stays compatible with the sequential path.
      const { runParallel } = await import('../workflow/executor.mjs');
      const r = await runParallel(nodes, { signal: sig.signal, concurrency: opts.concurrency });
      const executedNodes = r.results.filter(x => x.status === 'success').map(x => x.id);
      console.log(JSON.stringify({
        success: r.success,
        executedNodes,
        failedAt: r.failedAt || null,
        mode: 'parallel',
        aborted: r.error?.code === 'ABORT' || sig.wasAborted() || undefined,
        error: r.error?.message || null,
      }));
      process.exit(exitCodeFor(r, sig));
    }
    const { runPersistent } = await loadEngine();
    const r = await runPersistent(nodes, { sessionId, dir, maxRetries: opts.maxRetries ?? 3, signal: sig.signal });
    console.log(JSON.stringify({
      success: r.success,
      executedNodes: r.executedNodes,
      failedAt: r.failedAt,
      mode: 'sequential',
      aborted: r.code === 'ABORT' || sig.wasAborted() || undefined,
    }));
    process.exit(exitCodeFor(r, sig));
  } finally {
    sig.dispose();
  }
}

// Delete a persisted workflow state file. Idempotent — same shape
// as DELETE /workflows/<id> on the daemon. Confined to the state
// dir; a sessionId that resolves outside is rejected.
//
// Exit codes:
//   0 — file existed and was deleted (or didn't exist; either way ok)
//   1 — sessionId escapes the state dir / unsafe (refused)
//   2 — state directory does not exist (nothing to clear)
async function cmdClear(sessionId, opts = {}) {
  const dir = opts.dir || '.workflow-state';
  if (!fs.existsSync(dir)) {
    console.error(`State directory ${dir} does not exist`);
    process.exit(2);
  }
  const file = path.join(dir, `${sessionId}.json`);
  const resolvedDir = path.resolve(dir);
  const resolvedFile = path.resolve(file);
  if (!resolvedFile.startsWith(resolvedDir + path.sep) && resolvedFile !== resolvedDir) {
    console.error(`invalid sessionId: ${sessionId}`);
    process.exit(1);
  }
  const existed = fs.existsSync(resolvedFile);
  if (existed) fs.unlinkSync(resolvedFile);
  console.log(JSON.stringify({ ok: true, sessionId, removed: existed }));
  process.exit(0);
}

// Static validation of a workflow file. No execution — pure shape +
// topology check. Useful for CI:
//   $ lazyclaw validate ./flow.mjs && lazyclaw run job ./flow.mjs
//
// Checks (in order; the first hard failure short-circuits the rest
// for a fast CI signal, but soft warnings collect into `warnings`):
//   1. file imports cleanly and exports `nodes` (hard)
//   2. each node has a string `id` and an `execute` function (hard)
//   3. ids are unique (hard — duplicate is a silent bug)
//   4. deps reference known ids (warn by default — unknown deps are treated
//      as satisfied edges by topologicalLevels, so this is not fatal but
//      almost always a typo. --strict promotes it to a HARD failure so a CI
//      step catches the typo: `lazyclaw validate --strict ./flow.mjs`)
//   5. no cycles (hard — `topologicalLevels` returns `leftover` non-empty)
//
// Output JSON includes:
//   - ok: bool
//   - issues: hard-failure messages
//   - warnings: soft messages (still ok=true)
//   - levels: topological levels (one per concurrent batch)
//   - maxParallelism: max level width (informational — what the user's
//     `--concurrency` flag should at most be set to)
//
// Exit codes:
//   0 — valid (warnings ok)
//   1 — hard failure
//   2 — file path / import error (couldn't read or eval the file)
async function cmdValidate(file, opts = {}) {
  if (!file) { console.error('Usage: lazyclaw validate <workflow.mjs> [--strict]'); process.exit(2); }
  let nodes;
  try {
    nodes = await importWorkflow(file);
  } catch (e) {
    console.error(`validate: ${e?.message || e}`);
    process.exit(2);
  }
  const issues = [];
  const warnings = [];
  // Per-node shape validation. We continue past per-node failures so
  // the user sees every issue at once, not one-per-edit-cycle.
  const ids = new Set();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const where = `nodes[${i}]`;
    if (!n || typeof n !== 'object') { issues.push(`${where}: must be an object`); continue; }
    if (typeof n.id !== 'string' || n.id.length === 0) { issues.push(`${where}: missing or non-string id`); continue; }
    if (typeof n.execute !== 'function') issues.push(`${where} (id=${n.id}): execute is not a function`);
    if (ids.has(n.id)) issues.push(`${where}: duplicate id "${n.id}"`);
    ids.add(n.id);
    if (n.deps !== undefined && !Array.isArray(n.deps)) {
      issues.push(`${where} (id=${n.id}): deps must be an array of strings`);
    }
  }
  // Dep reference check. Default: warning (topologicalLevels tolerates them).
  // --strict: promote to a hard issue so a CI `validate` catches the typo.
  for (const n of nodes) {
    for (const d of n?.deps || []) {
      if (!ids.has(d)) {
        const msg = `node "${n.id}": dep "${d}" not found in this workflow`;
        if (opts.strict) issues.push(`${msg} (--strict)`);
        else warnings.push(`${msg} (will be treated as satisfied)`);
      }
    }
  }
  // Topology / cycle check — only meaningful when shape passed.
  let levels = null;
  let maxParallelism = 0;
  if (issues.length === 0) {
    const { topologicalLevels } = await import('../workflow/executor.mjs');
    const { levels: lvls, leftover } = topologicalLevels(nodes);
    levels = lvls;
    maxParallelism = lvls.reduce((m, l) => Math.max(m, l.length), 0);
    if (leftover.length > 0) {
      issues.push(`workflow has a cycle or unreachable nodes: ${leftover.join(', ')}`);
    }
  }
  const ok = issues.length === 0;
  console.log(JSON.stringify({
    ok, file, nodeCount: nodes.length, issues, warnings,
    levels, maxParallelism,
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

async function cmdResume(sessionId, file, opts = {}) {
  const { runPersistent, runPersistentDag, loadState, resumeEngineFromState } = await loadEngine();
  const dir = opts.dir || '.workflow-state';
  const prior = loadState(sessionId, dir);
  if (!prior) {
    console.error(`No state for session ${sessionId} in ${dir}`);
    process.exit(2);
  }
  const nodes = await importWorkflow(file);
  const sig = makeRunSignal();
  // Auto-select the engine from the persisted state (recorded by the original
  // run) so `resume` no longer requires re-passing --parallel-persistent. An
  // explicit flag still wins; a state file predating this metadata falls back
  // to the flag / sequential default.
  const persistedEngine = resumeEngineFromState(sessionId, dir);
  const useDag = opts['parallel-persistent'] || persistedEngine === 'parallel-persistent';
  try {
    if (useDag) {
      const r = await runPersistentDag(nodes, {
        sessionId, dir, timeoutMs: opts.timeoutMs,
        signal: sig.signal, concurrency: opts.concurrency,
      });
      console.log(JSON.stringify({
        success: r.success,
        executedNodes: r.executedNodes || [],
        failedAt: r.failedAt || null,
        resumed: true,
        mode: 'parallel-persistent',
        aborted: r.code === 'ABORT' || sig.wasAborted() || undefined,
        error: r.error || null,
      }));
      process.exit(exitCodeFor(r, sig));
    }
    const r = await runPersistent(nodes, { sessionId, dir, maxRetries: opts.maxRetries ?? 3, signal: sig.signal });
    console.log(JSON.stringify({
      success: r.success,
      executedNodes: r.executedNodes,
      failedAt: r.failedAt,
      resumed: true,
      mode: 'sequential',
      aborted: r.code === 'ABORT' || sig.wasAborted() || undefined,
    }));
    process.exit(exitCodeFor(r, sig));
  } finally {
    sig.dispose();
  }
}

// Route main()'s run/resume/inspect/clear/validate/graph cases here. Owns the
// arg-glue (positional/flag extraction) that previously lived inline in the
// cli.mjs switch, so the entrypoint case collapses to a one-line lazy import.
export async function dispatch(cmd, rest) {
  switch (cmd) {
    case 'run': {
      const [sessionId, file] = rest.positional;
      if (!sessionId || !file) { console.error('Usage: lazyclaw run <session-id> <workflow.mjs> [--parallel | --parallel-persistent] [--concurrency <N>]'); process.exit(2); }
      // --concurrency caps in-flight nodes within a single level for
      // both --parallel and --parallel-persistent. Sequential mode
      // ignores it (only one node runs at a time anyway).
      const concurrency = rest.flags.concurrency !== undefined
        ? Math.max(0, parseInt(rest.flags.concurrency, 10) || 0)
        : undefined;
      await cmdRun(sessionId, file, {
        dir: rest.flags.dir,
        parallel: !!rest.flags.parallel,
        'parallel-persistent': !!rest.flags['parallel-persistent'],
        concurrency,
      });
      break;
    }
    case 'resume': {
      const [sessionId, file] = rest.positional;
      if (!sessionId || !file) { console.error('Usage: lazyclaw resume <session-id> <workflow.mjs> [--parallel-persistent] [--concurrency <N>]'); process.exit(2); }
      const concurrency = rest.flags.concurrency !== undefined
        ? Math.max(0, parseInt(rest.flags.concurrency, 10) || 0)
        : undefined;
      await cmdResume(sessionId, file, {
        dir: rest.flags.dir,
        'parallel-persistent': !!rest.flags['parallel-persistent'],
        concurrency,
      });
      break;
    }
    case 'inspect': {
      // No-arg form lists every persisted session in the state dir.
      // Pass the empty positional through; cmdInspect's list mode
      // handles it.
      const [sessionId] = rest.positional;
      await cmdInspect(sessionId, {
        dir: rest.flags.dir,
        status: rest.flags.status,
        summary: !!rest.flags.summary,
        filter: rest.flags.filter,
        limit: rest.flags.limit,
        node: rest.flags.node,
        criticalPath: rest.flags['critical-path'],
        slowest: rest.flags.slowest,
        aggregate: !!rest.flags.aggregate,
      });
      break;
    }
    case 'clear': {
      const [sessionId] = rest.positional;
      if (!sessionId) { console.error('Usage: lazyclaw clear <session-id> [--dir <state-dir>]'); process.exit(2); }
      await cmdClear(sessionId, { dir: rest.flags.dir });
      break;
    }
    case 'validate': {
      const [file] = rest.positional;
      await cmdValidate(file, { strict: !!rest.flags.strict });
      break;
    }
    case 'graph': {
      const [file] = rest.positional;
      await cmdGraph(file, {
        lr: !!rest.flags.lr,
        state: rest.flags.state,
        dir: rest.flags.dir,
      });
      break;
    }
    default:
      throw new Error(`workflow.dispatch: unknown command "${cmd}"`);
  }
}
