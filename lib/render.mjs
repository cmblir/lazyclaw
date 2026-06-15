// lib/render.mjs — tiny shared pretty-printer for record-shaped command output.
// Turns an object into readable `key: value` lines instead of a raw JSON dump,
// so the *show handlers (/agent show, /team show, …) read cleanly in the chat
// scrollback. Pure, no imports.

// Format one value for a single line: empties → '(none)', arrays → [a, b],
// one-level objects → {k: v, …}, scalars → String(v), deeper → compact JSON.
function fmtValue(v) {
  if (v === null || v === undefined || v === '') return '(none)';
  if (Array.isArray(v)) return v.length ? `[${v.join(', ')}]` : '[]';
  if (typeof v === 'object') {
    const inner = Object.keys(v).map((k) => {
      const iv = v[k];
      const s = (iv && typeof iv === 'object') ? JSON.stringify(iv) : String(iv);
      return `${k}: ${s}`;
    });
    return `{${inner.join(', ')}}`;
  }
  return String(v);
}

/**
 * Render an object as `key: value` lines.
 * @param {object} obj
 * @param {{fields?: string[], hide?: string[]|Set<string>}} [opts]
 *   fields: explicit key order (keys absent on obj are skipped);
 *   hide: keys to omit (when fields not given).
 * @returns {string}
 */
export function renderRecord(obj, { fields, hide } = {}) {
  if (!obj || typeof obj !== 'object') return String(obj);
  const skip = hide instanceof Set ? hide : new Set(hide || []);
  const keys = Array.isArray(fields)
    ? fields.filter((k) => Object.prototype.hasOwnProperty.call(obj, k))
    : Object.keys(obj).filter((k) => !skip.has(k));
  return keys.map((k) => `${k}: ${fmtValue(obj[k])}`).join('\n');
}

// Convenience: raw JSON when `raw` is true, else the pretty render. Lets each
// handler offer a `<sub> <name> json` escape hatch in one line.
export function renderRecordOrJson(obj, opts, raw) {
  return raw ? JSON.stringify(obj, null, 2) : renderRecord(obj, opts);
}
