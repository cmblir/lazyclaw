// tui/editor.mjs — multiline input state machine (spec §5.8).
//
// Pure-functional core (makeEditorState, applyKey) so it is testable
// without ink stdin. The React component <Editor/> wraps useInput().
//
// v5.4: slash-popup integration. When the parent passes a non-empty
// `slashSuggestions` array, ↑/↓ move the popup selection (instead of
// scrolling history) and Tab/Enter fill the buffer with the highlighted
// command WITHOUT submitting it (Anthropic's recent UX rule: first
// Enter fills, second Enter runs). Esc clears the buffer + dismisses.
// All popup-aware branches are guarded by `slashOpen` so legacy callers
// see the pre-v5.4 behavior verbatim.
//
// v5.5: <Editor/> now renders inside a round-bordered Box — the
// Claude-CLI-style input frame. The border uses `theme.border` (a
// muted gray) so the accent `›` and sloth gutter stay the dominant
// amber notes. The box auto-fills the available terminal width via
// Ink's flex defaults and grows vertically as the buffer wraps onto
// new lines (Shift+Enter).
//
// v5.3.2: CJK / wide-character correctness. `string.length` returns the
// UTF-16 code-unit count, which is wrong for column math — a Hangul or
// Han glyph occupies 2 terminal cells but reports `.length === 1`. We
// keep `state.cursor` in codepoint-index units (so `buffer.slice(0,
// cursor)`, Backspace, and history recall still work), but expose all
// display-column math through the `displayWidth()` helper and the
// derived `cursorDisplayCol` field. The render also pins the Box to
// `width: '100%'` so Ink's wrap-ansi (already string-width aware) gets
// the full terminal budget — fixes the perceived right-edge truncation
// on long Korean buffers.
import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import stringWidth from 'string-width';
import { theme } from './theme.mjs';

// The accent prompt (`› `) prepended to the first rendered line. Its
// display width matters for any caller that wants to know the usable
// inner width of the editor box. Defined once so the value stays in
// sync if the prompt glyph ever changes.
export const PROMPT_PREFIX = '› ';
export const PROMPT_WIDTH = stringWidth(PROMPT_PREFIX);
export const CONTINUATION_GUTTER = '  ';
export const CONTINUATION_WIDTH = stringWidth(CONTINUATION_GUTTER);

// Public helper: display width of a buffer (or any substring of it),
// counting wide chars (CJK, fullwidth, most emoji) as 2 cells and
// ignoring ANSI escapes. Use this — never `.length` — for column math.
export function displayWidth(text) {
  if (!text) return 0;
  return stringWidth(String(text));
}

// ─── IME cursor anchor (v5.4.4) ─────────────────────────────────────
//
// v5.4.3 shipped an anchor that moved the cursor inside the editor
// after every render so IME pre-edit composition appeared in the
// editor box. It also caused visible flicker because Ink's log-update
// (node_modules/ink/build/log-update.js) emits an eraseLines sequence
// (`\x1b[2K\x1b[1A...`) on every redraw — and that sequence walks UP
// from the CURRENT cursor position. With our anchor up inside the
// editor, eraseLines erased rows ABOVE the frame, then wrote the new
// frame starting one editor-height higher than the previous one.
//
// v5.4.4 fix — monkey-patch process.stdout.write the first time the
// anchor fires. When the patched writer sees a chunk that BEGINS with
// `\x1b[2K` (the start of log-update's eraseLines) AND the anchor
// offset is non-zero, it prepends `\x1b[<offset>B\r` to move the
// cursor BACK DOWN to the row log-update expects (one below the
// previous frame's last line). The user sees no flicker; IME still
// reads the editor cursor position because the anchor lives across
// the gap between renders.
const _anchorState = { offset: 0, shimmed: false };

function _installAnchorShim() {
  if (_anchorState.shimmed) return;
  if (!(process.stdout && typeof process.stdout.write === 'function')) return;
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = function patchedWrite(chunk, ...rest) {
    try {
      if (
        _anchorState.offset > 0 &&
        typeof chunk === 'string' &&
        chunk.startsWith('\x1b[2K')
      ) {
        const off = _anchorState.offset;
        _anchorState.offset = 0;
        return orig.call(this, `\x1b[${off}B\r` + chunk, ...rest);
      }
    } catch { /* fall through to unmodified write */ }
    return orig.call(this, chunk, ...rest);
  };
  _anchorState.shimmed = true;
}

// Cell-aware soft-wrap. Returns an array of visual rows whose width
// respects the budget (first row uses `firstBudget`, subsequent rows
// use `contBudget`). Hoisted to module level (was inner-fn) so the
// cursor-anchor useEffect in <Editor/> can reuse it.
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

// Display column of the caret given a state. Counts wide chars as 2.
// On the first rendered line this is offset by PROMPT_WIDTH; on
// continuation lines (after a Shift+Enter) it is offset by
// CONTINUATION_WIDTH. Callers that only need the in-buffer column can
// pass `{ withPrefix: false }`.
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

export function applyKey(state, evt) {
  const { input = '', key = {}, paste = false } = evt;
  const next = { ...state, lastSubmit: null, lastWasPaste: false };

  if (key.return && key.shift) {
    next.buffer = state.buffer + '\n';
    next.cursor = next.buffer.length;
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
  if (key.backspace || key.delete) {
    next.buffer = state.buffer.slice(0, -1);
    next.cursor = next.buffer.length;
    return next;
  }
  if (input) {
    next.buffer = state.buffer + input;
    next.cursor = next.buffer.length;
    next.lastWasPaste = paste || input.length >= 16;
    return next;
  }
  return next;
}

// Pure helper used by the slash-popup branch in <Editor/>. Replaces the
// editor buffer with `${cmd} ` (note trailing space so the user can keep
// typing args without an extra keystroke). Does NOT submit.
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

export function Editor({
  history,
  onSubmit,
  onEscape,
  onBufferChange,
  // v5.4 slash-popup wiring (all optional — pre-v5.4 callers pass none):
  slashSuggestions,      // Array<{cmd,help}> | null
  slashSelectedIndex,    // number
  onSlashMove,           // (delta: -1 | +1) => void
  onSlashDismiss,        // () => void
  // v5.4.3 modal-picker wiring (all optional — pre-v5.4.3 callers pass none).
  // When modalOpen is true the Editor intercepts every key and routes it
  // to the host callbacks; nothing reaches applyKey / onSubmit so the
  // chat buffer is untouched while a picker is up.
  modalOpen,             // boolean
  modalQuery,            // string — current filter buffer (host-owned)
  onModalMove,           // (delta: -1 | +1) => void
  onModalConfirm,        // () => void
  onModalCancel,         // () => void
  onModalQuery,          // (next: string) => void
  // v5.4.3 IME cursor anchor — when altEnabled is true, the Editor
  // moves the terminal cursor back inside its content row after each
  // render so macOS IMEs (Hangul / Japanese / Chinese) draw their
  // pre-edit overlay at the actual typing position. Opt-out via the
  // LAZYCLAW_NO_CURSOR_ANCHOR env var (handled internally).
  altEnabled,
}) {
  const [state, setState] = useState(() => makeEditorState({ history }));
  const slashOpen = Array.isArray(slashSuggestions) && slashSuggestions.length > 0;

  // v5.4.2: keep a synchronous mirror of the editor state so back-to-back
  // keystrokes don't lose characters to React's stale-closure problem.
  // Korean / Japanese IME commits each completed syllable as a separate
  // stdin event; if two events fire inside one React frame the second
  // useInput call captures the pre-first-event `state` and overwrites
  // the first event's setState payload — leaving the first character
  // missing from `buffer`. Reading + writing through the ref means every
  // applyKey() sees the latest buffer regardless of render timing.
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  const commit = (next) => {
    stateRef.current = next;
    setState(next);
  };

  useInput((input, key) => {
    const current = stateRef.current;
    // ─── Modal-picker keyboard contract (highest priority — v5.4.3) ──
    // When a host-owned picker is up, EVERY key is consumed by the
    // picker. The chat buffer is never mutated and onSubmit is never
    // fired. This is what prevents "Enter while picking a model" from
    // accidentally submitting the typed-so-far buffer as a chat turn.
    if (modalOpen) {
      if (key.escape) { if (onModalCancel) onModalCancel(); return; }
      if (key.return) { if (onModalConfirm) onModalConfirm(); return; }
      if (key.upArrow)   { if (onModalMove) onModalMove(-1); return; }
      if (key.downArrow) { if (onModalMove) onModalMove(+1); return; }
      if (key.pageUp)    { if (onModalMove) onModalMove(-10); return; }
      if (key.pageDown)  { if (onModalMove) onModalMove(+10); return; }
      // Ctrl+U clears the filter (Unix-style line kill).
      if (key.ctrl && (input === 'u' || input === 'U')) {
        if (onModalQuery) onModalQuery('');
        return;
      }
      if (key.backspace || key.delete) {
        if (onModalQuery) onModalQuery(String(modalQuery || '').slice(0, -1));
        return;
      }
      // Printable single char (no modifier) appends to filter.
      if (input && !key.ctrl && !key.meta && input.length >= 1 && !key.tab) {
        if (onModalQuery) onModalQuery(String(modalQuery || '') + input);
        return;
      }
      // Anything else (Tab, function keys, etc.) swallowed.
      return;
    }
    // ─── Slash-popup keyboard contract (highest priority when open) ──
    if (slashOpen) {
      // Esc: clear the buffer and dismiss the popup. The host's onEscape
      // is NOT called in this branch — Esc here is a popup gesture, not
      // a turn-abort. (Outside of popup mode Esc still aborts streaming.)
      if (key.escape) {
        const cleared = { ...current, buffer: '', cursor: 0, lastSubmit: null, lastWasPaste: false };
        commit(cleared);
        if (onBufferChange) {
          try { onBufferChange(''); } catch {}
        }
        if (onSlashDismiss) onSlashDismiss();
        return;
      }
      // ↑/↓ navigate the popup instead of history.
      if (key.upArrow) {
        if (onSlashMove) onSlashMove(-1);
        return;
      }
      if (key.downArrow) {
        if (onSlashMove) onSlashMove(+1);
        return;
      }
      // Tab / Enter — fill the buffer with the highlighted command.
      // First Enter fills, second Enter runs (matches Anthropic's UX).
      // Exception: if the buffer already exactly matches the picked
      // command (with or without a trailing space), there is nothing left
      // to autocomplete. For Enter, fall through to the normal submit
      // path so /exit, /quit, /help etc. fire on a single Enter. For Tab
      // on an exact match, no-op.
      if (key.tab || key.return) {
        const safeIdx = Math.max(0, Math.min(slashSuggestions.length - 1, slashSelectedIndex || 0));
        const picked = slashSuggestions[safeIdx];
        const bufTrim = current.buffer.replace(/\s+$/, '');
        const alreadyExact = !!picked && (current.buffer === picked.cmd || bufTrim === picked.cmd);
        if (alreadyExact) {
          if (key.tab) return; // no completion to make
          // key.return on exact match → fall through to applyKey/submit.
        } else {
          if (picked) {
            const next = fillSlashCommand(current, picked.cmd);
            commit(next);
            if (onBufferChange) {
              try { onBufferChange(next.buffer); } catch {}
            }
          }
          return;
        }
      }
      // Anything else (printable, backspace) falls through to applyKey.
    }

    // Esc: forward to host (ReplApp uses this to abort an in-flight turn).
    // Do not mutate the buffer — the user may want to keep typing.
    if (key.escape) { if (onEscape) onEscape(); return; }
    const next = applyKey(current, { input, key });
    commit(next);
    if (onBufferChange) {
      try { onBufferChange(next.buffer); } catch { /* observer is best-effort */ }
    }
  });
  useEffect(() => {
    if (state.lastSubmit !== null && onSubmit) onSubmit(state.lastSubmit);
  }, [state.lastSubmit]);

  // v5.4.3 — IME cursor anchor.
  //
  // After every Ink render commit, move the terminal cursor BACK inside
  // the editor's content row so macOS Hangul / Japanese / Chinese IMEs
  // draw their pre-edit overlay where the user is actually typing
  // (instead of on the row below the editor box, where Ink's log-update
  // parks the cursor by default via its trailing '\n').
  //
  // Trade-off: each render briefly moves the cursor, which means the
  // NEXT render's log-update eraseLines starts from inside the editor.
  // Ink immediately overwrites with the full new frame, so the user
  // sees at most a one-tick flicker. The IME-correctness win is worth
  // the cosmetic cost. Opt out via LAZYCLAW_NO_CURSOR_ANCHOR=1.
  useEffect(() => {
    // Runs in BOTH the alt-buffer and the default (non-alt Static) layouts: the
    // editor is the last child either way, so the cursor parks below it and the
    // rowsUp math (editor geometry only) is identical. Anchoring in non-alt is
    // what makes the terminal cursor visible AT the caret (so you can see where
    // you're typing) and what keeps a CJK/Hangul IME pre-edit inside the box
    // instead of leaking onto the row below. Opt out via LAZYCLAW_NO_CURSOR_ANCHOR=1.
    void altEnabled;
    if (process.env.LAZYCLAW_NO_CURSOR_ANCHOR === '1') return;
    if (!(process.stdout && process.stdout.isTTY)) return;
    const cols = Math.max(20, process.stdout.columns || 80);
    const inner = Math.max(8, cols - 4);
    const fb = inner - PROMPT_WIDTH;
    const cb = inner - CONTINUATION_WIDTH;

    // Count total rendered rows (for "rowsUp" math) and locate the
    // cursor's (rowInEditor, colInLine) by wrapping the buffer up to
    // the codepoint cursor position.
    const fullLines = String(state.buffer || '').split('\n');
    let totalRows = 0;
    for (let li = 0; li < fullLines.length; li++) {
      const wrapped = wrapToBudget(fullLines[li], fb, cb);
      totalRows += wrapped.length;
    }
    const before = String(state.buffer || '').slice(0, state.cursor || 0);
    const beforeLines = before.split('\n');
    let rowInEditor = 0;
    for (let li = 0; li < beforeLines.length - 1; li++) {
      const wrapped = wrapToBudget(beforeLines[li], fb, cb);
      rowInEditor += wrapped.length;
    }
    const lastBefore = beforeLines[beforeLines.length - 1] || '';
    const lastWrapped = wrapToBudget(lastBefore, fb, cb);
    rowInEditor += lastWrapped.length - 1;
    const lastSegment = lastWrapped[lastWrapped.length - 1] || '';
    const colInLine = stringWidth(lastSegment);

    // After Ink writes `<frame>\n`, cursor sits on the line below the
    // editor's bottom border at column 0. Editor geometry: 1 top border
    // + totalRows content + 1 bottom border. So the row count between
    // "below editor" and the cursor's target content row is
    // (1 trailing-\n + 1 bottom border + (totalRows - 1 - rowInEditor))
    // = totalRows + 1 - rowInEditor.
    const rowsUp = Math.max(1, totalRows + 1 - rowInEditor);

    // Column: 1-indexed. Left border at col 1, padX at col 2, prefix
    // starts at col 3. Cursor sits one cell past the typed content.
    const prefixWidth = rowInEditor === 0 ? PROMPT_WIDTH : CONTINUATION_WIDTH;
    const colTarget = 3 + prefixWidth + colInLine;
    _installAnchorShim();
    _anchorState.offset = rowsUp;
    try {
      process.stdout.write(`\x1b[${rowsUp}A\x1b[${colTarget}G\x1b[?25h`);
    } catch { /* stdout closed — swallow */ }
  }, [state.buffer, state.cursor, altEnabled]);

  const lines = state.buffer.split('\n');
  // Ink's <Text wrap="wrap"> uses wrap-ansi (string-width aware) but the
  // box's width resolves against ink-testing-library's stdout shim and
  // some real terminals at 100 cols regardless of the actual viewport,
  // so wide CJK buffers bleed past the right edge in narrow terminals.
  // Pre-wrap to the actual cell budget via the module-level wrapToBudget
  // (see top of this file) so Ink never has to guess.
  const TERM = Math.max(20, process.stdout.columns || 80);
  // Box overhead: 1 border + 1 padX on each side = 4 cells; first row
  // also reserves PROMPT_WIDTH; continuation rows reserve CONTINUATION_WIDTH.
  const innerCells = Math.max(8, TERM - 4); // 2 border + 2 padX
  const renderedLines = [];
  for (let li = 0; li < lines.length; li++) {
    const wrapped = wrapToBudget(lines[li], innerCells - PROMPT_WIDTH, innerCells - CONTINUATION_WIDTH);
    for (let wi = 0; wi < wrapped.length; wi++) {
      const isFirstLogical = li === 0 && wi === 0;
      renderedLines.push({
        prefix: isFirstLogical ? theme.accent(PROMPT_PREFIX) : CONTINUATION_GUTTER,
        text: wrapped[wi],
      });
    }
  }
  return React.createElement(
    Box,
    {
      borderStyle: 'round',
      borderColor: theme.border,
      paddingX: 1,
      flexDirection: 'column',
      flexShrink: 0,
      width: TERM,
    },
    renderedLines.map((row, i) => React.createElement(
      Text,
      { key: i, wrap: 'truncate' },
      row.prefix + row.text,
    )),
  );
}
