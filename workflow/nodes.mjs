// workflow/nodes.mjs — the built-in node-type library for declarative workflows.
//
// A declarative workflow is data: a list of { id, type, config } specs. The
// compiler (workflow/declarative.mjs) turns each spec into a WorkflowNode the
// executor understands, resolving {{ref}} placeholders in `config` against a
// shared bag of prior node outputs first. Each node TYPE is a pure handler:
//   handler(config, ctx) => output    (sync or async)
//   ctx = { input, bag, caps, signal }
// Built-in types here are SAFE (no I/O). Side-effecting types (http, shell,
// llm, channel-send) are injected via caps.nodeTypes so the daemon decides
// what a workflow is allowed to do — capability injection, not ambient power.

// Resolve a dotted ref ("a.b.c") against the bag of prior outputs.
export function getRef(bag, pathStr) {
  const parts = String(pathStr).split('.');
  let v = bag;
  for (const p of parts) {
    if (v == null) return undefined;
    v = v[p.trim()];
  }
  return v;
}

const WHOLE_REF = /^\{\{\s*([\w.$-]+)\s*\}\}$/;
const INLINE_REF = /\{\{\s*([\w.$-]+)\s*\}\}/g;

// Deep-resolve {{ref}} placeholders in a config value against the bag. A string
// that is EXACTLY "{{ref}}" becomes the raw referenced value (may be a non-
// string); inline refs inside a longer string interpolate to text.
export function resolveRefs(value, bag) {
  if (typeof value === 'string') {
    const whole = value.match(WHOLE_REF);
    if (whole) return getRef(bag, whole[1]);
    return value.replace(INLINE_REF, (_, ref) => {
      const v = getRef(bag, ref);
      if (v == null) return '';
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((x) => resolveRefs(x, bag));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveRefs(v, bag);
    return out;
  }
  return value;
}

export const NODE_TYPES = {
  // Emit a constant (or a ref'd value). The simplest source node.
  set: (cfg) => (cfg && 'value' in cfg ? cfg.value : null),
  // A string built from prior outputs. cfg.text already had its {{refs}}
  // interpolated by the compiler, so this just returns the resolved string.
  template: (cfg) => String(cfg?.text ?? ''),
};
