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
import React, { useState, useEffect } from 'react';
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
}) {
  const [state, setState] = useState(() => makeEditorState({ history }));
  const slashOpen = Array.isArray(slashSuggestions) && slashSuggestions.length > 0;

  useInput((input, key) => {
    // ─── Slash-popup keyboard contract (highest priority when open) ──
    if (slashOpen) {
      // Esc: clear the buffer and dismiss the popup. The host's onEscape
      // is NOT called in this branch — Esc here is a popup gesture, not
      // a turn-abort. (Outside of popup mode Esc still aborts streaming.)
      if (key.escape) {
        const cleared = { ...state, buffer: '', cursor: 0, lastSubmit: null, lastWasPaste: false };
        setState(cleared);
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
        const bufTrim = state.buffer.replace(/\s+$/, '');
        const alreadyExact = !!picked && (state.buffer === picked.cmd || bufTrim === picked.cmd);
        if (alreadyExact) {
          if (key.tab) return; // no completion to make
          // key.return on exact match → fall through to applyKey/submit.
        } else {
          if (picked) {
            const next = fillSlashCommand(state, picked.cmd);
            setState(next);
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
    const next = applyKey(state, { input, key });
    setState(next);
    if (onBufferChange) {
      try { onBufferChange(next.buffer); } catch { /* observer is best-effort */ }
    }
  });
  useEffect(() => {
    if (state.lastSubmit !== null && onSubmit) onSubmit(state.lastSubmit);
  }, [state.lastSubmit]);

  const lines = state.buffer.split('\n');
  return React.createElement(
    Box,
    {
      borderStyle: 'round',
      borderColor: theme.border,
      paddingX: 1,
      flexDirection: 'column',
      flexShrink: 0,
      // Pin to full terminal width. Ink's wrap-ansi (which is
      // string-width aware) then has the correct cell budget for
      // wrapping long CJK buffers — fixes the right-edge truncation
      // perceived on Hangul / Han input. See `displayWidth`/
      // `cursorDisplayCol` above for the public width helpers.
      width: '100%',
    },
    lines.map((ln, i) => React.createElement(
      Text,
      { key: i },
      i === 0 ? theme.accent(PROMPT_PREFIX) + ln : CONTINUATION_GUTTER + ln,
    )),
  );
}
