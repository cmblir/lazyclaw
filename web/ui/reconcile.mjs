// web/ui/reconcile.mjs — keyed list update, no dependency, no framework.
//
// Most panels render once on entry and a full innerHTML swap is simpler.
// Tasks, Workflows, and Team Live's tile canvas do not: they change while
// you are looking at them. Replacing their DOM would throw away in-flight
// animations, keyboard focus, and the measured tile geometry Team Live's
// reporting-line edges (and Task 8's reassignment FLIP) are drawn from.
// This keeps the nodes: a survivor's Element identity never changes across
// calls, only the fields `update` chooses to touch.
//
// The per-node state lives in a WeakMap keyed by the host, so a caller does
// not have to thread it through.
const STATE = new WeakMap();

/**
 * @param {Element} host      container whose children are managed here
 * @param {Array} items       the new list, in the order it should appear
 * @param {(item) => string} keyOf   stable identity for an item
 * @param {(item) => Element} create build a node for a key seen for the first time
 * @param {(node, item) => void} update  refresh an existing node in place
 * @returns {Map<string, Element>} surviving nodes by key (feed to playFlip)
 */
export function reconcile(host, items, keyOf, create, update) {
  const prev = STATE.get(host) || new Map();
  const next = new Map();

  for (const item of items) {
    const key = keyOf(item);
    let node = prev.get(key);
    if (node) update(node, item);
    else node = create(item);
    next.set(key, node);
  }

  // Drop what disappeared. Every node in `prev` was placed into `host` by an
  // earlier call to this function, so removing it here is safe without first
  // re-checking node.parentNode — a real Element tracks that itself, but a
  // caller's host/node stand-in (e.g. a test double) need not, and this
  // function owns the full membership of `host`'s children regardless.
  for (const [key, node] of prev) {
    if (!next.has(key)) host.removeChild(node);
  }

  // Put survivors in the requested order, walking back-to-front so each
  // insertBefore's reference node has already been placed. insertBefore both
  // inserts a brand-new node and moves an existing one (removing it from its
  // old slot first) — one call handles both first paint and reordering.
  let cursor = null;
  const ordered = [...next.values()];
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    host.insertBefore(ordered[i], cursor);
    cursor = ordered[i];
  }

  STATE.set(host, next);
  return next;
}
