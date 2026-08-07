// Read-only workflow reporting commands (inspect / graph), extracted from
// commands/workflow.mjs to keep that file under the size ratchet. Pure
// analysis over persisted state + workflow files — no execution. Owns the
// two shared leaf helpers (loadEngine / importWorkflow) that both these
// commands and the lifecycle commands in workflow.mjs need; workflow.mjs
// imports them back from here so there is a single definition.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadEngine() {
  return import('../workflow/persistent.mjs');
}

export async function importWorkflow(file) {
  const abs = path.resolve(file);
  const url = pathToFileURL(abs).href;
  const mod = await import(url);
  if (!mod.nodes || !Array.isArray(mod.nodes)) {
    throw new Error(`Workflow file ${file} must export 'nodes' array`);
  }
  return mod.nodes;
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
export async function cmdInspect(sessionId, opts = {}) {
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
  // --critical-path [workflow.mjs]: compute the longest weighted path
  // through the DAG using each node's recorded durationMs. Useful for
  // "where's the bottleneck" analysis after a slow run.
  //
  // When a workflow file is given, deps come from the .mjs (works for state
  // predating persisted deps). When the flag is passed with NO file, deps are
  // reconstructed from the persisted `state.deps` — so a run recorded by a
  // recent engine needs no access to the original .mjs.
  if (opts.criticalPath) {
    let workflowNodes;
    if (opts.criticalPath === true) {
      // No file: reconstruct the graph from persisted order + deps.
      if (!state.deps) {
        console.error('critical-path: this state file has no persisted deps — pass the workflow file: --critical-path <workflow.mjs>');
        process.exit(2);
      }
      workflowNodes = (state.order || []).map(id => ({ id, deps: state.deps[id] || [] }));
    } else {
      try {
        workflowNodes = await importWorkflow(opts.criticalPath);
      } catch (e) {
        console.error(`critical-path: ${e?.message || e}`);
        process.exit(2);
      }
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
export async function cmdGraph(file, opts = {}) {
  if (!file) { console.error('Usage: pompos graph <workflow.mjs> [--lr] [--state <session-id>] [--dir <state-dir>]'); process.exit(2); }
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
