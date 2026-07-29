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
import { theme } from './theme.mjs';
import {
  nextCodepointIndex,
  INTERRUPT_WINDOW_MS,
  PROMPT_PREFIX,
  PROMPT_WIDTH,
  CONTINUATION_GUTTER,
  CONTINUATION_WIDTH,
  displayWidth,
  wrapToBudget,
  cursorDisplayCol,
  makeEditorState,
  applyKey,
  fillSlashCommand,
  fillArgToken,
} from './editor_keys.mjs';
import { anchorState as _anchorState } from './editor_anchor.mjs';
import { motionEnabled, useMotion, flashBorderColor, FLASH_MS, FLASH_TICK_MS } from './motion.mjs';
// Re-exported (not just imported) so the established import path
// `from '../tui/editor.mjs'` still resolves — flashBorderColor + FLASH_MS
// moved to motion.mjs to keep this file under the 500-line file-size gate.
export { flashBorderColor, FLASH_MS };

// Re-export the pure state machine + measurement helpers (moved to
// editor_keys.mjs to keep this file under the 500-line gate) so every
// existing import path (`from '../tui/editor.mjs'`) keeps working.
export {
  INTERRUPT_WINDOW_MS,
  PROMPT_PREFIX,
  PROMPT_WIDTH,
  CONTINUATION_GUTTER,
  CONTINUATION_WIDTH,
  displayWidth,
  wrapToBudget,
  cursorDisplayCol,
  makeEditorState,
  applyKey,
  fillSlashCommand,
};

export function Editor({
  history,
  onSubmit,
  onEscape,
  onBufferChange,
  // v6.4 2-stage Ctrl+C (optional — pre-v6.4 callers pass none). First press
  // fires onInterrupt (cancel in-flight turn / clear buffer); a second press
  // within INTERRUPT_WINDOW_MS fires onExit. Only reachable when Ink is
  // rendered with exitOnCtrlC:false (otherwise Ink intercepts Ctrl+C first).
  onInterrupt,           // () => void
  onExit,                // () => void
  // v5.4 slash-popup wiring (all optional — pre-v5.4 callers pass none):
  slashSuggestions,      // Array<{cmd,help}> | null
  slashSelectedIndex,    // number
  slashFillMode,         // 'command' (default) | 'arg' — arg fills the token via fillArgToken
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
  // v6.x slash-argument completion (all optional). When the buffer is a
  // command + a completable value, the host sets argCompletable; Tab then
  // calls onArgComplete(buffer) so the host opens the modal picker. The host
  // pushes the chosen value back via argInject={value,nonce}, which the
  // Editor applies with fillArgToken (only token under the cursor changes).
  argCompletable,        // boolean
  onArgComplete,         // (buffer: string) => void
  argInject,             // { value: string, nonce: number } | null
  // v6.x — timestamp (Date.now()) of the last failed turn (tui/repl_reducers.mjs
  // lastErrorAt), or null. Drives the border flash below via flashBorderColor.
  errorAt,
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

  // v6.4 — this-session input history. The parent (repl) grows `history` as
  // each prompt is submitted, but makeEditorState only snapshots it at mount,
  // so without this sync the editor's Up/Down never saw this-session prompts
  // (the audit gap). When the prop array CHANGES, mirror it into state and
  // reset historyIdx to the tip so the next Up recalls the newest submission.
  // The buffer/cursor are left untouched (don't disturb an in-progress draft).
  const historyKey = Array.isArray(history) ? history.join('\0') : '';
  const prevHistoryKeyRef = useRef(null);
  if (prevHistoryKeyRef.current === null) prevHistoryKeyRef.current = historyKey;
  useEffect(() => {
    if (prevHistoryKeyRef.current === historyKey) return;
    prevHistoryKeyRef.current = historyKey;
    const list = Array.isArray(history) ? history : [];
    commit({ ...stateRef.current, history: list, historyIdx: list.length });
  }, [historyKey]);

  // v6.4 — 2-stage Ctrl+C. Tracks the timestamp of the last Ctrl+C so a
  // second press within the window exits; the first only interrupts.
  const lastCtrlCRef = useRef(0);

  useInput((input, key) => {
    const current = stateRef.current;
    // ─── 2-stage Ctrl+C (highest priority — v6.4) ───────────────────────
    // Only reached when Ink is rendered with exitOnCtrlC:false; otherwise
    // Ink swallows Ctrl+C and exits before useInput sees it. First press
    // cancels the in-flight turn + clears the buffer (consistent with Esc);
    // a second press within INTERRUPT_WINDOW_MS exits.
    if (key.ctrl && (input === 'c' || input === 'C')) {
      const now = Date.now();
      if (now - lastCtrlCRef.current <= INTERRUPT_WINDOW_MS) {
        lastCtrlCRef.current = 0;
        if (onExit) onExit();
        return;
      }
      lastCtrlCRef.current = now;
      // Clear the draft + cancel in-flight work.
      const cleared = { ...current, buffer: '', cursor: 0, lastSubmit: null, lastWasPaste: false };
      commit(cleared);
      if (onBufferChange) { try { onBufferChange(''); } catch {} }
      if (onInterrupt) onInterrupt();
      return;
    }
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
        if (slashFillMode === 'arg') {
          // Arg popup: picked.cmd holds the candidate VALUE. Fill it into the
          // token in place. When the token already equals the candidate, Enter
          // falls through to submit (Tab no-ops).
          const start = Math.max(current.buffer.lastIndexOf(' '), current.buffer.lastIndexOf(',')) + 1;
          const exact = !!picked && current.buffer.slice(start) === picked.cmd;
          if (exact && key.return) {
            // token complete → fall through to applyKey/submit
          } else {
            if (!exact && picked) {
              const next = fillArgToken(current, picked.cmd);
              commit(next);
              if (onBufferChange) { try { onBufferChange(next.buffer); } catch {} }
            }
            return;
          }
        } else {
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
      }
      // Anything else (printable, backspace) falls through to applyKey.
    }

    // Arg completion: Tab while typing a command's value (slash popup closed,
    // no modal) hands the buffer to the host, which opens the picker and pushes
    // the choice back via argInject. Without a completer, Tab falls through.
    if (!slashOpen && key.tab && argCompletable && onArgComplete) {
      onArgComplete(stateRef.current.buffer);
      return;
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

  // Apply a host-pushed arg-completion value into the buffer (the picker the
  // host opened resolved to `value`). Guarded by a monotonic nonce so the same
  // value can be injected twice and re-renders don't re-apply a stale value.
  const injectNonceRef = useRef(0);
  useEffect(() => {
    if (argInject && argInject.nonce !== injectNonceRef.current && typeof argInject.value === 'string') {
      injectNonceRef.current = argInject.nonce;
      const nextState = fillArgToken(stateRef.current, argInject.value);
      commit(nextState);
      if (onBufferChange) { try { onBufferChange(nextState.buffer); } catch {} }
    }
  }, [argInject]);

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
    const colInLine = displayWidth(lastSegment);

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
    // The shim this effect depends on is installed at mount by ReplApp, NOT
    // here: it also carries the stray-write redirect, which must stay on even
    // when LAZYCLAW_NO_CURSOR_ANCHOR turns this effect off above.
    // If a previous anchor moved the cursor up and NO render's eraseLines has
    // consumed that offset yet (two state updates between redraws — e.g. fast
    // typing or backspace), the cursor is still parked up inside the editor.
    // Undo that move first (\x1b[<pending>B) so we re-anchor from the true
    // "below the frame" baseline. Without this the moves stacked, the shim
    // only compensated for the LAST one, and eraseLines walked up into — and
    // erased — the scrollback above the editor (corruption was invisible in
    // the fixed alt-buffer canvas, visible in the default Static layout).
    const pending = _anchorState.offset;
    const undo = pending > 0 ? `\x1b[${pending}B\r` : '';
    _anchorState.offset = rowsUp;
    // `writing` tells the shim this chunk IS the anchor's displacement, so it
    // neither compensates it nor hands it to Ink as a stray write.
    _anchorState.writing = true;
    try {
      process.stdout.write(`${undo}\x1b[${rowsUp}A\x1b[${colTarget}G\x1b[?25h`);
    } catch { /* stdout closed — swallow */ } finally { _anchorState.writing = false; }
  });
  // ^ NO dependency array — re-anchor after EVERY commit. Renders triggered
  // by OTHER components (status-bar ticks, streaming output) redraw the
  // frame and park the terminal cursor below it; with buffer-only deps the
  // anchor didn't re-run and the cursor drifted out of the box whenever the
  // user wasn't typing. The pending-offset undo above makes repeats safe.

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
  // Caret position in BUFFER code units (split by logical line). caretLine is
  // the index into `lines`; caretCol is the code-unit offset within that line.
  const beforeCaret = state.buffer.slice(0, state.cursor || 0);
  const beforeLines = beforeCaret.split('\n');
  const caretLine = beforeLines.length - 1;
  const caretCol = beforeLines[beforeLines.length - 1].length;
  const renderedLines = [];
  // While wrapping each logical line, find which rendered row the caret sits
  // on and its code-unit offset within that row's text (so the inverse-video
  // caret can be drawn AT the cursor, not always at the end).
  let caretRow = -1;
  let caretRowOffset = 0;
  for (let li = 0; li < lines.length; li++) {
    const wrapped = wrapToBudget(lines[li], innerCells - PROMPT_WIDTH, innerCells - CONTINUATION_WIDTH);
    let consumed = 0; // code units of this logical line placed into prior rows
    for (let wi = 0; wi < wrapped.length; wi++) {
      const isFirstLogical = li === 0 && wi === 0;
      const seg = wrapped[wi];
      if (li === caretLine && caretRow === -1) {
        const isLastSeg = wi === wrapped.length - 1;
        // The caret belongs to this row if its column falls within the row's
        // span, or it's the last segment (end-of-line caret rests here).
        if (caretCol <= consumed + seg.length || isLastSeg) {
          caretRow = renderedLines.length;
          caretRowOffset = Math.max(0, caretCol - consumed);
        }
      }
      renderedLines.push({
        prefix: isFirstLogical ? theme.accent(PROMPT_PREFIX) : CONTINUATION_GUTTER,
        text: seg,
      });
      consumed += seg.length;
    }
  }
  // Always-visible caret: an inverse-video cell drawn AT the cursor. Mid-line,
  // it highlights the character under the cursor (block caret); at end-of-row
  // it appends an inverse space. The real terminal cursor is anchored to the
  // same cell for IME pre-edit; this glyph keeps the position visible even
  // between anchor writes (e.g. while another component renders). Hidden while
  // a modal picker owns the keyboard so it can't masquerade as an active prompt.
  if (!modalOpen && renderedLines.length > 0) {
    if (caretRow === -1) caretRow = renderedLines.length - 1;
    const row = renderedLines[caretRow];
    const off = Math.min(caretRowOffset, row.text.length);
    const head = row.text.slice(0, off);
    const rest = row.text.slice(off);
    if (rest.length > 0) {
      // Highlight the character at the cursor (codepoint-safe slice).
      const at = nextCodepointIndex(rest, 0);
      row.text = `${head}\x1b[7m${rest.slice(0, at)}\x1b[27m${rest.slice(at)}`;
    } else {
      row.text = `${head}\x1b[7m \x1b[27m`;
    }
  }
  const flashMotion = motionEnabled();
  // Re-render through the flash window so the pulse is visible; the interval
  // stops the moment the window closes.
  const flashActive = flashMotion && errorAt != null && (Date.now() - errorAt) < FLASH_MS;
  const flashTick = useMotion(flashActive, FLASH_TICK_MS);
  void flashTick; // consumed only for its re-render side effect
  const borderColor = flashBorderColor(errorAt, Date.now(), flashMotion);
  return React.createElement(
    Box,
    {
      borderStyle: 'round',
      borderColor,
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
