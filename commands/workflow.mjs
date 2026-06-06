// Workflow lifecycle commands (run / resume / inspect / clear / validate /
// graph), extracted from cli.mjs in Phase D3. Fully self-contained: depends
// only on node builtins and the workflow/ engine modules, no registry/config/
// TUI coupling. main() routes its six cases here through dispatch(cmd, rest).
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

async function loadEngine() {
  return import('../workflow/persistent.mjs');
}

async function importWorkflow(file) {
  const abs = path.resolve(file);
  const url = pathToFileURL(abs).href;
  const mod = await import(url);
  if (!mod.nodes || !Array.isArray(mod.nodes)) {
    throw new Error(`Workflow file ${file} must export 'nodes' array`);
  }
  return mod.nodes;
}

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

// Pure transformation over a persisted state file — no execution.
// The shape mirrors the on-disk state plus a derived `summary` block
// so a script can decide "should I resume?" without parsing per-node
// statuses itself.
//
// With no sessionId, lists every state file in `dir` with a summary
// block per session — sorted by updatedAt descending so the most
// recently touched run sits at the top.
//
// Exit codes (single-session mode):
//   0 — state found and printed
//   1 — workflow completed (all nodes success, no work left to resume)
//   2 — state file not found
//   3 — workflow failed and is NOT resumable as-is (terminal failure
//       with retries exhausted; user must edit the workflow or state)
//
// Exit codes (list mode):
//   0 — listing produced (even if empty — empty dir is valid state)
//   2 — `dir` does not exist
async function cmdInspect(sessionId, opts = {}) {
  const dir = opts.dir || '.workflow-state';
  const { loadState } = await loadEngine();
  const { summarizeState, listSessions, aggregateNodeStats } = await import('../workflow/summary.mjs');

  // --aggregate (list mode): per-node statistics across every
  // session in the state dir — count, success/failed/pending/running
  // counts, and min/max/avg/total durations. Answers "which node
  // tends to be slow or fail across all my runs?" — a question
  // single-session inspect can't answer.
  if (!sessionId && opts.aggregate) {
    let stats;
    try {
      stats = aggregateNodeStats(dir, { filter: opts.filter });
    } catch (e) {
      if (e?.code === 'ENOENT') {
        console.error(`State directory ${dir} does not exist`);
        process.exit(2);
      }
      throw e;
    }
    // --aggregate --node <id>: drill into one node's cross-session
    // stats. Useful when you've already identified the bottleneck
    // and want to track its trend across runs without scrolling
    // the full table.
    if (opts.node) {
      const nodeStat = stats.nodeStats[opts.node];
      if (!nodeStat) {
        console.error(`No node "${opts.node}" found across sessions in ${dir} (known: ${Object.keys(stats.nodeStats).join(', ') || 'none'})`);
        process.exit(2);
      }
      console.log(JSON.stringify({
        dir,
        filter: opts.filter || null,
        sessionCount: stats.sessionCount,
        nodeId: opts.node,
        ...nodeStat,
      }, null, 2));
      process.exit(0);
    }
    console.log(JSON.stringify({ dir, filter: opts.filter || null, ...stats }, null, 2));
    process.exit(0);
  }

  // List mode — no sessionId given. Walks the state directory and
  // emits a summary per session. Per-node `nodes` map is omitted —
  // run with a session id for full detail.
  //
  // --status filters the listing by lifecycle: done, resumable,
  // failed, or running. Mutually exclusive — passing more than one
  // is an error rather than silent overlap so a script can rely on
  // the predicate it asked for.
  if (!sessionId) {
    let sessions;
    try {
      sessions = listSessions(dir);
    } catch (e) {
      if (e?.code === 'ENOENT') {
        console.error(`State directory ${dir} does not exist`);
        process.exit(2);
      }
      throw e;
    }
    const status = opts.status;
    if (status) {
      const valid = new Set(['done', 'resumable', 'failed', 'running']);
      if (!valid.has(status)) {
        console.error(`invalid --status: ${status} (expected one of: ${[...valid].join(', ')})`);
        process.exit(2);
      }
      sessions = sessions.filter(s => {
        if (status === 'done')      return s.summary.done;
        if (status === 'resumable') return s.summary.resumable;
        if (status === 'failed')    return s.summary.failed > 0;
        if (status === 'running')   return s.summary.running > 0;
        return true;
      });
    }
    // --filter <substr>: case-insensitive sessionId substring (same
    // semantic as v3.33's sessions/skills list filter).
    // --limit <N>: post-filter cap. Composes with --status (status
    // first, then filter, then limit).
    if (opts.filter) {
      const f = String(opts.filter).toLowerCase();
      sessions = sessions.filter(s => s.sessionId.toLowerCase().includes(f));
    }
    if (opts.limit !== undefined) {
      const n = parseInt(opts.limit, 10);
      if (Number.isFinite(n) && n > 0) sessions = sessions.slice(0, n);
    }
    console.log(JSON.stringify({ dir, status: status || null, sessions }, null, 2));
    process.exit(0);
  }

  const state = loadState(sessionId, dir);
  if (!state) {
    console.error(`No state for session ${sessionId} in ${dir}`);
    process.exit(2);
  }
  // --node <id>: drill into one node's state. Useful for scripts
  // checking a specific node ("did node 'classify' succeed?")
  // without reading the full state body. Exit codes mirror the
  // node's status:
  //   0 — node exists and status is success or pending or running
  //   1 — node exists and status is failed (script-friendly red)
  //   2 — node doesn't exist in this session (typo or wrong workflow)
  if (opts.node) {
    const ns = state.nodes?.[opts.node];
    if (!ns) {
      console.error(`No node "${opts.node}" in session ${sessionId} (known: ${Object.keys(state.nodes || {}).join(', ')})`);
      process.exit(2);
    }
    console.log(JSON.stringify({
      sessionId: state.sessionId,
      nodeId: opts.node,
      ...ns,
    }, null, 2));
    process.exit(ns.status === 'failed' ? 1 : 0);
  }
  // --slowest <N>: top N nodes by durationMs. Pure state-file
  // analysis — no workflow file needed (deps are irrelevant to
  // "which node took the longest"). Sorted descending; ties
  // broken by id ascending so the output is deterministic.
  if (opts.slowest !== undefined) {
    const n = parseInt(opts.slowest, 10);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`--slowest must be a positive integer (got ${JSON.stringify(opts.slowest)})`);
      process.exit(2);
    }
    const entries = Object.entries(state.nodes || {}).map(([id, ns]) => ({
      id,
      status: ns?.status || 'pending',
      durationMs: Number.isFinite(ns?.durationMs) ? ns.durationMs : 0,
      attempts: ns?.attempts ?? 0,
    }));
    entries.sort((a, b) => (b.durationMs - a.durationMs) || a.id.localeCompare(b.id));
    console.log(JSON.stringify({
      sessionId: state.sessionId,
      top: entries.slice(0, n),
    }, null, 2));
    process.exit(0);
  }
  // --critical-path <workflow.mjs>: compute the longest weighted path
  // through the DAG using each node's recorded durationMs. Useful for
  // "where's the bottleneck" analysis after a slow run. Requires the
  // workflow file because the state file doesn't persist deps.
  if (opts.criticalPath) {
    let workflowNodes;
    try {
      workflowNodes = await importWorkflow(opts.criticalPath);
    } catch (e) {
      console.error(`critical-path: ${e?.message || e}`);
      process.exit(2);
    }
    const { criticalPath } = await import('../workflow/summary.mjs');
    const result = criticalPath(workflowNodes, state.nodes || {});
    console.log(JSON.stringify({
      sessionId: state.sessionId,
      ...result,
    }, null, 2));
    process.exit(0);
  }
  const { summary, failedNodes } = summarizeState(state);
  // --summary trims the per-node `nodes` map and `order` from the
  // single-session output, leaving only `summary` + `failedNodes` +
  // timestamps. Useful for "I just want the headline" — the same
  // shape list-mode produces per session, so a script can normalize
  // output across both modes by passing --summary in single mode.
  const compact = !!opts.summary;
  const out = compact
    ? {
        sessionId: state.sessionId,
        dir,
        summary,
        failedNodes,
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
      }
    : {
        sessionId: state.sessionId,
        dir,
        summary,
        failedNodes,
        order: state.order,
        nodes: state.nodes,
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
      };
  console.log(JSON.stringify(out, null, 2));
  if (summary.done) process.exit(1);
  if (summary.failed > 0) process.exit(3);
  process.exit(0);
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
//   4. deps reference known ids (warn — unknown deps are treated as
//      satisfied edges by topologicalLevels, so this is not fatal
//      but almost always a typo)
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
async function cmdValidate(file) {
  if (!file) { console.error('Usage: lazyclaw validate <workflow.mjs>'); process.exit(2); }
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
  // Dep reference check (warnings — topologicalLevels tolerates them).
  for (const n of nodes) {
    for (const d of n?.deps || []) {
      if (!ids.has(d)) warnings.push(`node "${n.id}": dep "${d}" not found in this workflow (will be treated as satisfied)`);
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

// Emit a workflow's DAG as Mermaid syntax. Useful for docs, code
// review, and quick visual debugging — Mermaid renders inline in
// GitHub markdown, GitLab, Notion, Obsidian, and most modern note
// tools, so the output is paste-ready.
//
// Direction is top-down (`graph TD`) by default; --lr flag flips it
// to left-right which is more readable for wide DAGs.
//
// Output goes to stdout as plain text (the Mermaid block contents,
// no fenced ```mermaid wrapper). The user adds the fence when
// embedding so the same output works for the editors that DON'T
// render markdown.
//
// Each node id is sanitized to a Mermaid-safe identifier (letters,
// digits, underscores) for the LHS reference, with the original id
// in brackets as the visible label. So `fetch-data` becomes
// `fetch_data[fetch-data]` in the output — Mermaid's id rules are
// stricter than ours.
async function cmdGraph(file, opts = {}) {
  if (!file) { console.error('Usage: lazyclaw graph <workflow.mjs> [--lr] [--state <session-id>] [--dir <state-dir>]'); process.exit(2); }
  let nodes;
  try {
    nodes = await importWorkflow(file);
  } catch (e) {
    console.error(`graph: ${e?.message || e}`);
    process.exit(2);
  }
  // --state <session-id> overlays current run status onto each node
  // (success/running/failed/pending). Without a state, every node
  // gets a neutral declaration. With state, nodes are tagged with a
  // CSS class via Mermaid's classDef + class syntax — paste-able
  // straight into a render, and renders that don't support classDef
  // (rare) just ignore the styling and show the raw graph.
  let state = null;
  if (opts.state) {
    const dir = opts.dir || '.workflow-state';
    const { loadState } = await loadEngine();
    state = loadState(opts.state, dir);
    if (!state) {
      console.error(`graph: no state for session ${opts.state} in ${dir}`);
      process.exit(2);
    }
  }
  const direction = opts.lr ? 'LR' : 'TD';
  const lines = [`graph ${direction}`];
  // Mermaid node ids must match /[a-zA-Z][a-zA-Z0-9_]*/ — anything
  // else needs the bracketed-label form. We always emit the bracket
  // label so the visible text is the user's actual id (no ambiguity)
  // while the LHS identifier is always Mermaid-safe.
  const safeId = (id) => {
    const s = String(id).replace(/[^a-zA-Z0-9_]/g, '_');
    return /^[a-zA-Z]/.test(s) ? s : `n_${s}`;
  };
  // Per-status visual cues. Unicode glyph in the label + classDef
  // class for color. The glyph alone works in plain markdown
  // viewers; the classDef adds color for Mermaid renders.
  const statusGlyph = {
    success: ' ✓',
    running: ' ⏳',
    failed:  ' ✗',
    pending: '',
  };
  const declared = new Set();
  const classedNodes = { success: [], running: [], failed: [], pending: [] };
  const declare = (id) => {
    if (declared.has(id)) return;
    let label = id;
    let cls = null;
    if (state) {
      const ns = state.nodes?.[id];
      const st = ns?.status || 'pending';
      label = id + (statusGlyph[st] || '');
      cls = st;
      classedNodes[st]?.push(safeId(id));
    }
    lines.push(`  ${safeId(id)}[${label}]`);
    declared.add(id);
  };
  for (const n of nodes) declare(n.id);
  for (const n of nodes) {
    for (const d of n.deps || []) {
      // Edge: dep → node. Mermaid syntax `a --> b`.
      lines.push(`  ${safeId(d)} --> ${safeId(n.id)}`);
    }
  }
  if (state) {
    // GitHub's Mermaid theme renders these well in both light/dark
    // mode. Operators rendering in their own theme can override.
    lines.push('  classDef success fill:#9f6,stroke:#363,stroke-width:1px;');
    lines.push('  classDef running fill:#fc6,stroke:#963,stroke-width:1px;');
    lines.push('  classDef failed  fill:#f66,stroke:#933,stroke-width:1px;');
    lines.push('  classDef pending fill:#ddd,stroke:#666,stroke-width:1px;');
    for (const [cls, ids] of Object.entries(classedNodes)) {
      if (ids.length === 0) continue;
      // `class id1,id2,id3 className` — Mermaid syntax for batch class assignment.
      lines.push(`  class ${ids.join(',')} ${cls};`);
    }
  }
  console.log(lines.join('\n'));
  process.exit(0);
}

async function cmdResume(sessionId, file, opts = {}) {
  const { runPersistent, runPersistentDag, loadState } = await loadEngine();
  const dir = opts.dir || '.workflow-state';
  const prior = loadState(sessionId, dir);
  if (!prior) {
    console.error(`No state for session ${sessionId} in ${dir}`);
    process.exit(2);
  }
  const nodes = await importWorkflow(file);
  const sig = makeRunSignal();
  try {
    // --parallel-persistent picks the DAG engine. Sequential by default
    // — same flag the run command uses, so the resume invocation
    // mirrors the original run invocation. (We can't auto-detect the
    // engine from the state file alone; both engines write the same
    // shape. The user knows which mode they originally ran.)
    if (opts['parallel-persistent']) {
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
      await cmdValidate(file);
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
