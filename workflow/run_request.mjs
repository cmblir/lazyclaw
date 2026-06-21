// workflow/run_request.mjs — bridge a declarative workflow definition + the
// daemon/CLI config into a safe run. Caps are derived from config, NOT from the
// workflow: http (SSRF-guarded) is always granted; llm is bound to the
// configured provider when one resolves. Shell and other powerful types are
// NOT granted here — a posted workflow can never spawn a process. Returns a
// plain serializable result; throws WorkflowError on a malformed definition.

import { validateWorkflow, runWorkflow } from './declarative.mjs';
import { buildCaps } from './builtin_caps.mjs';

export async function runDeclarativeRequest(def, cfg = {}, opts = {}) {
  validateWorkflow(def); // throws WorkflowError (caught by the caller → 400)
  const provider = typeof opts.providerLookup === 'function' ? opts.providerLookup(cfg.provider) : null;
  const grants = { http: { fetchImpl: opts.fetchImpl || globalThis.fetch } };
  if (provider && typeof provider.sendMessage === 'function') {
    grants.llm = { provider, apiKey: cfg['api-key'], model: cfg.model };
  }
  const caps = buildCaps(grants);
  const r = await runWorkflow(def, { caps, input: opts.input, signal: opts.signal });
  return {
    ok: r.success,
    success: r.success,
    session: r.session || {},
    results: (r.results || []).map((x) => ({ id: x.id, status: x.status, duration: x.duration })),
    ...(r.error ? { error: r.error.message, failedAt: r.failedAt } : {}),
  };
}
