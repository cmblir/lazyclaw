// tui/modal_filter.mjs — pure (react-free) primitives for the Ink modal
// picker. Split out from modal_picker.mjs so the filtering / windowing /
// pick-resolution logic is unit-testable without pulling in react + ink
// (which are only present in the running TUI). modal_picker.mjs re-exports
// these for back-compat.

// Pure filter — prefix > substring > subsequence. Stable order within each
// tier (original list order is the tiebreaker).
//
// `pinned` rows bypass the filter entirely and are always appended after
// the matches. This keeps sentinel rows (e.g. "↻ fetch live models",
// "… type a custom model id") on screen while the user types an id that
// matches no listed model — the typed filter doubles as the custom-id
// buffer for the free-text row.
export function filterModalItems(query, items) {
  const q = String(query || '').trim().toLowerCase();
  const list = Array.isArray(items) ? items : [];
  if (!q) return list.slice();
  const prefix = [], substr = [], subseq = [], pinned = [];
  for (const it of list) {
    if (it && it.pinned) { pinned.push(it); continue; }
    const hay = `${it.label || it.id || ''} ${it.desc || ''}`.toLowerCase();
    if (hay.startsWith(q)) prefix.push(it);
    else if (hay.includes(q)) substr.push(it);
    else if (_isSubseq(q, hay)) subseq.push(it);
  }
  return [...prefix, ...substr, ...subseq, ...pinned];
}

function _isSubseq(needle, hay) {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}

// Pure window computation — slide a window of `maxRows` items so that
// `selectedIndex` is always visible. Mirrors the pattern in
// tui/slash_popup.mjs._computeWindow.
export function _computeWindow(idx, total, maxRows) {
  const n = Math.max(0, total);
  const m = Math.max(1, maxRows);
  if (n <= m) return { start: 0, end: n };
  let start = Math.max(0, Math.min(n - m, idx - Math.floor(m / 2)));
  return { start, end: start + m };
}

// Pure pick resolver — maps the highlighted row + current filter buffer to
// what openPicker resolves with. A `freeText` row resolves to
// `{ id, query }` so the caller can use the typed filter as a custom value
// (e.g. an unlisted model id); every other row resolves to its plain id.
// No selection resolves to null (caller treats as cancel).
export function resolveModalPick(pickedItem, query) {
  if (!pickedItem) return null;
  if (pickedItem.freeText) return { id: pickedItem.id, query: String(query || '') };
  return pickedItem.id;
}
