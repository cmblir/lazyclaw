// tui/slash_helpers.mjs — shared leaf helpers for the slash-command dispatcher
// and its sibling handler modules. Extracted verbatim from slash_dispatcher.mjs
// so the dispatcher, dashboard, channels, and trainer modules share one set of
// pure utilities without a circular import. These import nothing from the
// dispatcher.

// Tiny utility — split args on whitespace, drop empties. Used by sub-command
// handlers that don't need the loop-engine's full quote-aware splitter.
export function splitWhitespace(s) {
  return (s || '').split(/\s+/).filter(Boolean);
}

// Parse a "provider[:model]" spec, preferring the registry's parser.
export function _parseProvModel(registry, spec) {
  if (registry && typeof registry.parseProviderModel === 'function') return registry.parseProviderModel(spec);
  const s = String(spec || '');
  const i = s.indexOf(':');
  if (i < 0) return { provider: s || null, model: null };
  return { provider: s.slice(0, i) || null, model: s.slice(i + 1) || null };
}

// Best-effort dynamic import. Returns the resolved ctx field if the caller
// pre-injected it (test hot path), else loads the real module. Throwing is
// fine — handlers wrap calls in try/catch where appropriate.
export async function _mod(ctx, key, importer) {
  if (ctx && ctx[key]) return ctx[key];
  return importer();
}

/**
 * Read config.json for a read-merge-write.
 *
 * Returns `{ cfg }` when the file parsed or is genuinely absent, and
 * `{ error }` when it exists but could not be read — those are NOT the same
 * thing. Callers used to swallow both into `{}` and write back only the block
 * they were setting, which silently replaced an operator's whole config
 * because of one misplaced comma.
 */
export function readConfigForMerge(cfgPath, fs) {
  let raw;
  try {
    raw = fs.readFileSync(cfgPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { cfg: {} };   // genuinely fresh
    return { error: `config.json at ${cfgPath} could not be read (${err?.code || err?.message}) — not overwriting it` };
  }
  try {
    return { cfg: JSON.parse(raw) };
  } catch (err) {
    return { error: `config.json at ${cfgPath} is not valid JSON (${err?.message}) — refusing to overwrite it; fix the file, or move it aside to start fresh` };
  }
}

// Single free-text prompt reusing the modal's filter buffer (no dedicated
// input widget). Returns the typed value, '' (only when allowEmpty), or null
// on cancel / required-but-empty.
export async function _promptText(ctx, { title, subtitle, allowEmpty, secret } = {}) {
  if (typeof ctx.openPicker !== 'function') return null;
  const picked = await ctx.openPicker({
    kind: 'text',
    title,
    // `secret` masks the typed query on screen (api-key / token entry) while
    // the real value still reaches the caller — the modal picker honors it.
    secret: !!secret,
    subtitle: subtitle || 'type into the filter, then pick the row · Esc cancels',
    items: [{ id: '__text__', label: '✓ use what I typed above', desc: '', pinned: true, freeText: true }],
  });
  if (picked == null) return null;
  if (typeof picked === 'object') {
    const v = String(picked.query || '').trim();
    if (!v && !allowEmpty) return null;
    return v;
  }
  return null;
}

// Yes/no confirmation modal for sensitive-tool approval. Esc (or no modal
// available) DENIES — approval is never granted by omission.
export async function _promptConfirm(ctx, { title, subtitle } = {}) {
  if (typeof ctx.openPicker !== 'function') return false;
  const picked = await ctx.openPicker({
    kind: 'menu',
    title: title || 'Approve sensitive tool?',
    subtitle: subtitle || 'Enter selects · Esc denies',
    items: [
      { id: 'approve', label: '✓ approve once', desc: 'run this tool call' },
      { id: 'deny', label: '✗ deny', desc: 'block this tool call' },
    ],
  });
  const id = picked && typeof picked === 'object' ? picked.id : picked;
  return id === 'approve';
}
