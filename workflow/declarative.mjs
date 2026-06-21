// workflow/declarative.mjs — parse + compile + run a declarative workflow.
//
// Workflows used to be hand-written .mjs that passed arbitrary node functions
// to the executor (workflow/executor.mjs). This compiles a DATA definition
// (JSON; a node-type library backs it) into the same WorkflowNode shape, so a
// workflow can be authored, stored, and run from config — and, next, served by
// the daemon over HTTP. Orchestration (ordering, timeout, retry, cleanup,
// cancellation) is still the existing executor; this layer only builds nodes.
//
// Definition shape:
//   { name?, input?, nodes: [ { id, type, config?, deps?, timeoutMs?, retry? } ] }
// Data flows by {{ref}}: a node's config can reference any prior node's output
// by id (e.g. "{{fetchUser.name}}"), resolved from a shared bag at run time.

import { runSequential } from './executor.mjs';
import { NODE_TYPES, resolveRefs } from './nodes.mjs';

export class WorkflowError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code || 'WF_ERR';
  }
}

// Validate the static shape (ids present + unique, nodes is an array). Type
// existence is checked at compile time, where the caps-provided types are known.
export function validateWorkflow(def) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    throw new WorkflowError('workflow must be an object', 'WF_SHAPE');
  }
  if (!Array.isArray(def.nodes) || def.nodes.length === 0) {
    throw new WorkflowError('workflow needs a non-empty nodes[] array', 'WF_NODES');
  }
  const ids = new Set();
  for (const n of def.nodes) {
    if (!n || typeof n !== 'object') throw new WorkflowError('each node must be an object', 'WF_NODE');
    if (typeof n.id !== 'string' || !n.id.trim()) throw new WorkflowError('each node needs a non-empty string id', 'WF_NODE_ID');
    if (ids.has(n.id)) throw new WorkflowError(`duplicate node id: ${n.id}`, 'WF_DUP_ID');
    ids.add(n.id);
    if (typeof n.type !== 'string' || !n.type.trim()) throw new WorkflowError(`node "${n.id}" needs a type`, 'WF_NODE_TYPE');
  }
  return def;
}

export function parseWorkflow(text) {
  let def;
  try { def = JSON.parse(text); }
  catch (e) { throw new WorkflowError(`invalid workflow JSON: ${e.message}`, 'WF_PARSE'); }
  return validateWorkflow(def);
}

// Compile a (validated) definition into executor nodes. caps.nodeTypes adds
// side-effecting node types (http/shell/llm/channel) the caller chose to grant;
// the built-in safe types are always present. Returns { nodes, bag } where bag
// accumulates each node's output by id for {{ref}} resolution.
export function compileWorkflow(def, caps = {}) {
  validateWorkflow(def);
  const registry = { ...NODE_TYPES, ...(caps.nodeTypes && typeof caps.nodeTypes === 'object' ? caps.nodeTypes : {}) };
  for (const spec of def.nodes) {
    if (typeof registry[spec.type] !== 'function') {
      throw new WorkflowError(`unknown node type "${spec.type}" (node "${spec.id}") — known: ${Object.keys(registry).join(', ')}`, 'WF_UNKNOWN_TYPE');
    }
  }
  const bag = {};
  const nodes = def.nodes.map((spec) => ({
    id: spec.id,
    deps: Array.isArray(spec.deps) ? spec.deps : undefined,
    timeoutMs: spec.timeoutMs,
    retry: spec.retry,
    execute: async (input, ctx = {}) => {
      const handler = registry[spec.type];
      const cfg = resolveRefs(spec.config || {}, bag);
      const out = await handler(cfg, { input, bag, caps, signal: ctx.signal });
      bag[spec.id] = out;
      return out;
    },
  }));
  return { nodes, bag };
}

// Compile + run a declarative workflow sequentially. Returns the executor's
// { success, results, session } (session[id] = each node's output).
export async function runWorkflow(def, opts = {}) {
  const { nodes } = compileWorkflow(def, opts.caps || {});
  return runSequential(nodes, opts.input ?? null, { signal: opts.signal });
}
