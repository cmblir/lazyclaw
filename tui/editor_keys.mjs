// tui/editor_keys.mjs — pure editor state machine + cursor-aware editing
// helpers for <Editor/> (v6.4).
//
// Extracted from tui/editor.mjs to keep that file under the 500-line gate.
// editor.mjs re-exports the public surface (makeEditorState, applyKey,
// displayWidth, cursorDisplayCol, wrapToBudget, fillSlashCommand and the
// PROMPT_* / CONTINUATION_* constants) so all existing import paths stay
// valid. These operate on the editor state's `buffer` (a string) and
// `cursor` (a UTF-16 code-unit index — the same unit `buffer.slice(0,
// cursor)` expects). Movement steps over whole codepoints so a surrogate
// pair (e.g. an emoji) is never split mid-character.
import stringWidth from 'string-width';

// v6.4 — 2-stage Ctrl+C window. A second Ctrl+C within this many ms exits;
// otherwise the first press only cancels/clears and resets the timer.
export const INTERRUPT_WINDOW_MS = 1500;

// The accent prompt (`› `) prepended to the first rendered line. Its display
// width matters for any caller that wants the usable inner width of the box.
export const PROMPT_PREFIX = '› ';
export const PROMPT_WIDTH = stringWidth(PROMPT_PREFIX);
export const CONTINUATION_GUTTER = '  ';
export const CONTINUATION_WIDTH = stringWidth(CONTINUATION_GUTTER);

// Public helper: display width of a buffer (or any substring), counting wide
// chars (CJK, fullwidth, most emoji) as 2 cells and ignoring ANSI escapes.
// Use this — never `.length` — for column math.
export function displayWidth(text) {
  if (!text) return 0;
  return stringWidth(String(text));
}

// Cell-aware soft-wrap. Returns an array of visual rows whose width respects
// the budget (first row uses `firstBudget`, subsequent rows use `contBudget`).
export function wrapToBudget(text, firstBudget, contBudget) {
  if (!text) return [''];
  const out = [];
  let line = '';
  let lineW = 0;
  let budget = firstBudget;
  for (const ch of text) {
    const w = stringWidth(ch);
    if (lineW + w > budget) {
      out.push(line);
      line = ch;
      lineW = w;
      budget = contBudget;
    } else {
      line += ch;
      lineW += w;
    }
  }
  out.push(line);
  return out;
}

// Display column of the caret given a state. Counts wide chars as 2. On the
// first rendered line this is offset by PROMPT_WIDTH; on continuation lines
// (after a Shift+Enter) it is offset by CONTINUATION_WIDTH. Callers that only
// need the in-buffer column can pass `{ withPrefix: false }`.
export function cursorDisplayCol(state, { withPrefix = true } = {}) {
  const before = String(state.buffer || '').slice(0, state.cursor || 0);
  const newlineIdx = before.lastIndexOf('\n');
  const lineSlice = newlineIdx === -1 ? before : before.slice(newlineIdx + 1);
  const inLine = stringWidth(lineSlice);
  if (!withPrefix) return inLine;
  const prefix = newlineIdx === -1 ? PROMPT_WIDTH : CONTINUATION_WIDTH;
  return prefix + inLine;
}

export function makeEditorState({ history = [] } = {}) {
  return {
    buffer: '',
    cursor: 0,
    historyIdx: history.length,
    history,
    lastSubmit: null,
    lastWasPaste: false,
  };
}

// Pure reducer: apply one key event to the editor state, returning the next
// state. Cursor-aware (v6.4) — insert/Backspace act AT the cursor, with
// Left/Right/Home/End/Ctrl+A/E/K/W movement & edit shortcuts.
export function applyKey(state, evt) {
  const { input = '', key = {}, paste = false } = evt;
  const next = { ...state, lastSubmit: null, lastWasPaste: false };

  if (key.return && key.shift) {
    // Insert a literal newline AT the cursor (cursor-aware multiline edit).
    const r = insertAt(state.buffer, state.cursor, '\n');
    next.buffer = r.buffer;
    next.cursor = r.cursor;
    return next;
  }
  if (key.return) {
    next.lastSubmit = state.buffer;
    next.buffer = '';
    next.cursor = 0;
    next.historyIdx = state.history.length;
    return next;
  }
  if (key.upArrow) {
    const idx = Math.max(0, state.historyIdx - 1);
    if (state.history[idx] !== undefined) {
      next.historyIdx = idx;
      next.buffer = state.history[idx];
      next.cursor = next.buffer.length;
    }
    return next;
  }
  if (key.downArrow) {
    const idx = Math.min(state.history.length, state.historyIdx + 1);
    next.historyIdx = idx;
    next.buffer = state.history[idx] !== undefined ? state.history[idx] : '';
    next.cursor = next.buffer.length;
    return next;
  }
  // ─── Mid-line cursor movement (v6.4) ──────────────────────────────────
  if (key.leftArrow) {
    next.cursor = prevCodepointIndex(state.buffer, state.cursor);
    return next;
  }
  if (key.rightArrow) {
    next.cursor = nextCodepointIndex(state.buffer, state.cursor);
    return next;
  }
  // Home / Ctrl+A → start of the current line; End / Ctrl+E → end of it.
  if (key.home || (key.ctrl && (input === 'a' || input === 'A'))) {
    next.cursor = lineStartIndex(state.buffer, state.cursor);
    return next;
  }
  if (key.end || (key.ctrl && (input === 'e' || input === 'E'))) {
    next.cursor = lineEndIndex(state.buffer, state.cursor);
    return next;
  }
  // Ctrl+K kill-to-end-of-line; Ctrl+W delete-word-backward.
  if (key.ctrl && (input === 'k' || input === 'K')) {
    const r = killToLineEnd(state.buffer, state.cursor);
    next.buffer = r.buffer;
    next.cursor = r.cursor;
    return next;
  }
  if (key.ctrl && (input === 'w' || input === 'W')) {
    const r = deleteWordBackward(state.buffer, state.cursor);
    next.buffer = r.buffer;
    next.cursor = r.cursor;
    return next;
  }
  if (key.backspace || key.delete) {
    // Delete the codepoint BEFORE the cursor (not always the end-of-buffer).
    const r = deleteBackward(state.buffer, state.cursor);
    next.buffer = r.buffer;
    next.cursor = r.cursor;
    return next;
  }
  if (input) {
    // Other Ctrl/Meta chords are not insertable text — swallow so they
    // don't land as literal letters in the buffer.
    if (key.ctrl || key.meta) return next;
    // Insert AT the cursor (was: always append at end).
    const r = insertAt(state.buffer, state.cursor, input);
    next.buffer = r.buffer;
    next.cursor = r.cursor;
    next.lastWasPaste = paste || input.length >= 16;
    return next;
  }
  return next;
}

// Pure helper used by the slash-popup branch in <Editor/>. Replaces the
// editor buffer with `${cmd} ` (trailing space so the user can keep typing
// args without an extra keystroke). Does NOT submit.
export function fillSlashCommand(state, cmd) {
  const filled = cmd.endsWith(' ') ? cmd : cmd + ' ';
  return {
    ...state,
    buffer: filled,
    cursor: filled.length,
    lastSubmit: null,
    lastWasPaste: false,
  };
}

// Replace the whitespace-delimited token that ENDS the buffer with `value`.
// Used by slash-argument completion: the user types `/model gpt`, picks
// `gpt-4.1` from the modal, and the partial token is swapped in place. Does NOT
// submit. Leaves the cursor at the end of the inserted value. When the buffer
// ends in a space (empty arg token), `value` is appended.
export function fillArgToken(state, value) {
  const buffer = state.buffer || '';
  // Replace the token after the last separator. Comma is a separator too so
  // comma-lists (`/skill a,b`) complete the trailing segment in place.
  const start = Math.max(buffer.lastIndexOf(' '), buffer.lastIndexOf(',')) + 1;
  const filled = buffer.slice(0, start) + value;
  return {
    ...state,
    buffer: filled,
    cursor: filled.length,
    lastSubmit: null,
    lastWasPaste: false,
  };
}

// Step one codepoint LEFT of `idx` in `buffer` (UTF-16 aware). Returns the
// new index (>= 0). If the char before idx is a low surrogate, skip both
// units so we land before the full astral codepoint.
export function prevCodepointIndex(buffer, idx) {
  if (idx <= 0) return 0;
  const code = buffer.charCodeAt(idx - 1);
  // Low surrogate (0xDC00–0xDFFF) preceded by a high surrogate → 2 units.
  if (code >= 0xdc00 && code <= 0xdfff && idx >= 2) {
    const hi = buffer.charCodeAt(idx - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return idx - 2;
  }
  return idx - 1;
}

// Step one codepoint RIGHT of `idx` in `buffer`. Returns the new index
// (<= buffer.length). High surrogate at idx → consume both units.
export function nextCodepointIndex(buffer, idx) {
  const len = buffer.length;
  if (idx >= len) return len;
  const code = buffer.charCodeAt(idx);
  if (code >= 0xd800 && code <= 0xdbff && idx + 1 < len) {
    const lo = buffer.charCodeAt(idx + 1);
    if (lo >= 0xdc00 && lo <= 0xdfff) return idx + 2;
  }
  return idx + 1;
}

// Index of the start of the current logical line (after the last '\n' at or
// before `idx`). Home / Ctrl+A target.
export function lineStartIndex(buffer, idx) {
  const nl = buffer.lastIndexOf('\n', Math.max(0, idx - 1));
  return nl === -1 ? 0 : nl + 1;
}

// Index of the end of the current logical line (the next '\n' at or after
// `idx`, or end of buffer). End / Ctrl+E target.
export function lineEndIndex(buffer, idx) {
  const nl = buffer.indexOf('\n', idx);
  return nl === -1 ? buffer.length : nl;
}

// Insert `text` at `cursor`, returning { buffer, cursor }. Cursor advances by
// the inserted text's code-unit length so it rests just after the insertion.
export function insertAt(buffer, cursor, text) {
  const before = buffer.slice(0, cursor);
  const after = buffer.slice(cursor);
  return { buffer: before + text + after, cursor: cursor + text.length };
}

// Backspace: delete one codepoint BEFORE the cursor (no-op at column 0).
export function deleteBackward(buffer, cursor) {
  if (cursor <= 0) return { buffer, cursor };
  const start = prevCodepointIndex(buffer, cursor);
  return { buffer: buffer.slice(0, start) + buffer.slice(cursor), cursor: start };
}

// Ctrl+K: kill from the cursor to the end of the current logical line.
export function killToLineEnd(buffer, cursor) {
  const end = lineEndIndex(buffer, cursor);
  return { buffer: buffer.slice(0, cursor) + buffer.slice(end), cursor };
}

// Ctrl+W: delete the whitespace-delimited word before the cursor. Eats any
// run of trailing spaces first (so "foo " + Ctrl+W removes "foo "), matching
// readline's unix-word-rubout.
export function deleteWordBackward(buffer, cursor) {
  let i = cursor;
  while (i > 0 && /\s/.test(buffer[i - 1])) i -= 1;   // trailing whitespace
  while (i > 0 && !/\s/.test(buffer[i - 1])) i -= 1;   // the word itself
  return { buffer: buffer.slice(0, i) + buffer.slice(cursor), cursor: i };
}
