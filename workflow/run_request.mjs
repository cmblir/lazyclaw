// workflow/run_request.mjs — bridge a declarative workflow definition + the
// daemon/CLI config into a safe run. Caps are derived from config, NOT from the
// workflow: http (SSRF-guarded) is always granted; llm is bound to the
// configured provider when one resolves. Shell and other powerful types are
// NOT granted here — a posted workflow can never spawn a process. Returns a
// plain serializable result; throws WorkflowError on a malformed definition.

import { validateWorkflow, runWorkflow, compileWorkflow } from './declarative.mjs';
import { buildCaps } from './builtin_caps.mjs';
import { runPersistent, loadState } from './persistent.mjs';

// Caps from config (never the workflow): http always, llm bound to the
// configured provider, nothing else. Shared by the stateless + persistent paths.
function _capsFromConfig(cfg, opts) {
  const provider = typeof opts.providerLookup === 'function' ? opts.providerLookup(cfg.provider) : null;
  const grants = { http: { fetchImpl: opts.fetchImpl || globalThis.fetch } };
  if (provider && typeof provider.sendMessage === 'function') {
    grants.llm = { provider, apiKey: cfg['api-key'], model: cfg.model };
  }
  return buildCaps(grants);
}

export async function runDeclarativeRequest(def, cfg = {}, opts = {}) {
  validateWorkflow(def); // throws WorkflowError (caught by the caller → 400)
  // sessionId opts in to the persisted/resumable engine (state under opts.dir).
  if (opts.sessionId) return runDeclarativePersistent(def, cfg, opts);
  const caps = _capsFromConfig(cfg, opts);
  const r = await runWorkflow(def, { caps, input: opts.input, signal: opts.signal });
  return {
    ok: r.success,
    success: r.success,
    session: r.session || {},
    results: (r.results || []).map((x) => ({ id: x.id, status: x.status, duration: x.duration })),
    ...(r.error ? { error: r.error.message, failedAt: r.failedAt } : {}),
  };
}

// Persisted/resumable run: state is keyed by sessionId under opts.dir. A second
// call with the same sessionId resumes — already-succeeded nodes are skipped.
// CRITICAL: the declarative {{ref}} bag is closed over the compiled nodes, so on
// resume the skipped nodes never repopulate it. We pre-seed the bag from the
// prior state's success outputs, or a downstream {{ref}} to a skipped node would
// resolve to undefined.
export async function runDeclarativePersistent(def, cfg = {}, opts = {}) {
  validateWorkflow(def);
  const caps = _capsFromConfig(cfg, opts);
  const { nodes, bag } = compileWorkflow(def, caps);
  if (opts.input !== undefined) bag.input = opts.input;
  const prior = loadState(opts.sessionId, opts.dir);
  if (prior && prior.nodes) {
    for (const id of (prior.order || [])) {
      const ns = prior.nodes[id];
      if (ns && ns.status === 'success' && 'output' in ns) bag[id] = ns.output;
    }
  }
  const r = await runPersistent(nodes, { sessionId: opts.sessionId, dir: opts.dir, signal: opts.signal });
  // Reconstruct the {nodeId: output} session view from the persisted state so
  // the response shape matches the stateless path.
  const session = {};
  if (r.state && r.state.nodes) {
    for (const id of (r.state.order || [])) {
      const ns = r.state.nodes[id];
      if (ns && 'output' in ns) session[id] = ns.output;
    }
  }
  return {
    ok: r.success,
    success: r.success,
    session,
    sessionId: opts.sessionId,
    executedNodes: r.executedNodes || [],
    ...(r.error ? { error: r.error, failedAt: r.failedAt } : {}),
  };
}
