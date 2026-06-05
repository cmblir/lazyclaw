// tui/repl.mjs — REPL host with mid-stream interrupt-and-redirect
// (spec §5.8) AND a sticky-bottom chat layout (v5.3).
//
// Layout (top → bottom inside the outer column):
//   1. <Static items={scrollback}/> — splash item + per-turn user/assistant
//      blocks. Static renders each item ONCE to terminal scrollback and
//      never re-renders it, so the splash + history scroll away naturally
//      as new content appends. This is the Claude CLI / opencode pattern
//      translated to Ink's idiom — Static IS the scroll buffer.
//   2. Live region — partial assistant stream (state.liveAssistant) and
//      optional <SlashHints/> while the input buffer starts with '/'.
//      This Box re-renders on every chunk; the rest of the tree does not.
//   3. <StatusBar/> — single row above the input. flexShrink:0.
//   4. <Editor/> — sticky bottom, content-sized (1 line idle, grows with
//      multiline). Last sibling in the column so it pins to the bottom.
//
// Streaming chunks now flow into React state via an injected writeFn
// (state.liveAssistant += chunk). On turn completion the accumulated
// text is committed to scrollback so React stops re-rendering it.
// This closes the v5.0.10 TODO from cli.mjs:2628-2632.
//
// Backward-compat contracts (do not break):
//   - makeReplState()              — still callable with zero args.
//   - onUserInput, onEscape, onTurnComplete, consumeNextTurnFirstMessage
//     keep their pre-v5.3 shapes (tests/phaseC-repl-interrupt.test.mjs).
//   - ReplApp({ splashProps, runTurn })  — legacy callsite (cli.mjs:2637)
//     still works; runTurn writes go to wherever its writeFn points.
//   - ReplApp({ splashProps, runTurnFactory })  — new callsite for the
//     sticky layout; ReplApp injects writeFn → scrollback.
//
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Box, Static, Text, useApp } from 'ink';
import { Splash, renderSplashToString } from './splash.mjs';
import { Editor } from './editor.mjs';
import { SlashPopup, filterSlashCommands } from './slash_popup.mjs';
import { SLASH_COMMANDS } from './slash_commands.mjs';
import { theme } from './theme.mjs';

// ─── Pure state ──────────────────────────────────────────────────────────
//
// makeReplState stays callable with zero args (existing tests rely on it).
// The new fields default to empty so legacy callers see no behavior change.
export function makeReplState(opts) {
  const splashItem = opts && opts.splashItem ? opts.splashItem : null;
  return {
    streaming: false,
    controller: null,
    pendingPrepend: null,
    nextTurnFirstMessage: null,
    history: [],
    scrollback: splashItem ? [splashItem] : [],
    liveAssistant: '',
    turnCounter: 0,
  };
}

export function onUserInput(state, { text, controller }) {
  if (state.streaming && state.controller) {
    // mid-stream interrupt — abort current turn, queue text for next turn.
    try { state.controller.abort(); } catch {}
    return { ...state, pendingPrepend: text };
  }
  // idle — start a new turn. Append a 'user' entry to scrollback so the
  // sticky-layout caller sees the prompt history above the live stream.
  const id = `u-${state.turnCounter}`;
  return {
    ...state,
    streaming: true,
    controller,
    history: [...state.history, text],
    scrollback: [...state.scrollback, { kind: 'user', id, text }],
    turnCounter: state.turnCounter + 1,
  };
}

export function onEscape(state) {
  if (state.streaming && state.controller) {
    try { state.controller.abort(); } catch {}
  }
  // Drop any partial live assistant text on explicit Esc — the user is
  // telling us to discard, not to keep.
  return {
    ...state,
    streaming: false,
    controller: null,
    pendingPrepend: null,
    liveAssistant: '',
  };
}

// New reducer: stream chunk arrives, accumulate in liveAssistant.
export function onStreamChunk(state, { chunk }) {
  return { ...state, liveAssistant: state.liveAssistant + chunk };
}

export function onTurnComplete(state, { reason } = {}) {
  const promoted = state.pendingPrepend;
  const suffix = reason === 'aborted' ? ' [aborted]'
              : reason === 'error'   ? ' [error]'
              : '';
  const text = (state.liveAssistant || '') + suffix;
  // Commit any accumulated live text to scrollback. If the turn produced
  // nothing AND wasn't an error/abort, skip the empty append.
  const shouldCommit = text.length > 0 && (state.liveAssistant.length > 0 || suffix.length > 0);
  const id = `a-${state.turnCounter}`;
  const kind = reason === 'error' ? 'error' : 'assistant';
  const nextScrollback = shouldCommit
    ? [...state.scrollback, { kind, id, text }]
    : state.scrollback;
  return {
    ...state,
    streaming: false,
    controller: null,
    pendingPrepend: null,
    nextTurnFirstMessage: promoted,
    liveAssistant: '',
    scrollback: nextScrollback,
    turnCounter: state.turnCounter + 1,
  };
}

export function consumeNextTurnFirstMessage(state) {
  const msg = state.nextTurnFirstMessage;
  return [{ ...state, nextTurnFirstMessage: null }, msg];
}

// ─── React mount ─────────────────────────────────────────────────────────
//
// Two prop modes:
//   - runTurnFactory(writeFn) → runTurn(text, signal)   (sticky layout)
//   - runTurn(text, signal)                              (legacy, stdout)
// Legacy mode is preserved verbatim for the existing cli.mjs callsite.
export function ReplApp({ splashProps, runTurn, runTurnFactory, slashCommands }) {
  // Splash is rendered ONCE as scrollback[0] via <Static>. Build it lazily
  // so SSR-style imports without a TTY don't crash on process.stdout.
  const splashItemRef = useRef(null);
  if (splashItemRef.current === null) {
    splashItemRef.current = splashProps
      ? { kind: 'splash', id: 'splash-0', splashProps }
      : null;
  }
  const [state, setState] = useState(() => makeReplState({ splashItem: splashItemRef.current }));
  const { exit } = useApp();

  // writeFn for run_turn: route chunks into React state instead of stdout.
  // Only used when runTurnFactory is provided; the legacy `runTurn` prop
  // keeps writing wherever its caller wired it.
  const writeFn = useCallback((chunk) => {
    setState((s) => onStreamChunk(s, { chunk }));
  }, []);

  // Build the actual runTurn once. Prefer factory (new); fall back to
  // the legacy `runTurn` prop (existing cli.mjs callsite).
  const runTurnRef = useRef(null);
  if (runTurnRef.current === null) {
    if (typeof runTurnFactory === 'function') {
      runTurnRef.current = runTurnFactory(writeFn);
    } else if (typeof runTurn === 'function') {
      runTurnRef.current = runTurn;
    } else {
      runTurnRef.current = async () => {};
    }
  }

  const handleSubmit = useCallback(async (text) => {
    if (text === '/exit' || text === '/quit') { exit(); return; }
    const controller = new AbortController();
    setState((s) => onUserInput(s, { text, controller }));
    try {
      await runTurnRef.current(text, controller.signal);
      setState((s) => onTurnComplete(s, { reason: 'done' }));
    } catch (err) {
      setState((s) => onTurnComplete(s, {
        reason: err && err.name === 'AbortError' ? 'aborted' : 'error',
      }));
    }
  }, [exit]);

  // Auto-submit queued mid-stream-interrupt message (spec §5.8). Read
  // state.nextTurnFirstMessage so the effect re-fires when promoted.
  useEffect(() => {
    if (state.nextTurnFirstMessage) {
      const msg = state.nextTurnFirstMessage;
      setState((s) => ({ ...s, nextTurnFirstMessage: null }));
      handleSubmit(msg);
    }
  }, [state.nextTurnFirstMessage, handleSubmit]);

  // Esc handler — abort streaming turn, drop partial output.
  const onEscapeKey = useCallback(() => {
    setState((s) => onEscape(s));
  }, []);

  // ─── Slash popup state (v5.4) ──────────────────────────────────────
  // The editor reports its current buffer via onBufferChange; we derive
  // the filtered command list from that and own the selection index.
  const catalog = useMemo(
    () => (Array.isArray(slashCommands) && slashCommands.length > 0
      ? slashCommands : SLASH_COMMANDS),
    [slashCommands]
  );
  const [bufferPeek, setBufferPeek] = useState('');
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const filtered = useMemo(
    () => filterSlashCommands(bufferPeek, catalog),
    [bufferPeek, catalog]
  );
  // Reset selection whenever the match list changes length (typing
  // narrows results, so highlight the first row again).
  const lastLenRef = useRef(0);
  useEffect(() => {
    if (filtered.length !== lastLenRef.current) {
      setSelectedSuggestion(0);
      lastLenRef.current = filtered.length;
    } else if (selectedSuggestion >= filtered.length) {
      setSelectedSuggestion(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, selectedSuggestion]);

  const handleBufferChange = useCallback((buf) => {
    setBufferPeek(buf || '');
  }, []);
  const handleSlashMove = useCallback((delta) => {
    setSelectedSuggestion((i) => {
      const max = Math.max(0, filtered.length - 1);
      const n = i + delta;
      if (n < 0) return 0;
      if (n > max) return max;
      return n;
    });
  }, [filtered.length]);
  const handleSlashDismiss = useCallback(() => {
    setBufferPeek('');
    setSelectedSuggestion(0);
  }, []);

  const showSlashPopup = bufferPeek.startsWith('/') && filtered.length > 0;

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    // 1) Scrollback (write-once via Ink Static)
    React.createElement(
      Static,
      { items: state.scrollback },
      (item) => React.createElement(ScrollbackItem, { key: item.id, item })
    ),
    // 2) Live region — partial assistant stream
    state.liveAssistant
      ? React.createElement(
          Box,
          { flexDirection: 'column' },
          React.createElement(Text, { color: theme.fg }, state.liveAssistant)
        )
      : null,
    // 3) Slash popup — flex sibling above the StatusBar; Ink can't
    //    absolutely position so this is the "just above input" pattern.
    showSlashPopup
      ? React.createElement(SlashPopup, {
          buffer: bufferPeek,
          commands: filtered,
          selectedIndex: selectedSuggestion,
        })
      : null,
    // 4) Status bar (sticky, single row above input)
    React.createElement(StatusBar, {
      provider: splashProps && splashProps.provider,
      model: splashProps && splashProps.model,
      streaming: state.streaming,
      ctxUsed: splashProps && splashProps.ctxUsed,
      ctxTotal: splashProps && splashProps.ctxTotal,
    }),
    // 5) Editor — sticky bottom, content-sized
    React.createElement(Editor, {
      history: state.history,
      onSubmit: handleSubmit,
      onEscape: onEscapeKey,
      onBufferChange: handleBufferChange,
      slashSuggestions: showSlashPopup ? filtered : null,
      slashSelectedIndex: selectedSuggestion,
      onSlashMove: handleSlashMove,
      onSlashDismiss: handleSlashDismiss,
    })
  );
}

// ScrollbackItem renders each <Static/> child. Splash renders via the
// real <Splash/> component (preserves gradient wordmark colorization);
// everything else is plain Text.
export function ScrollbackItem({ item }) {
  if (item.kind === 'splash') {
    return React.createElement(Splash, item.splashProps);
  }
  if (item.kind === 'user') {
    return React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(Text, null, theme.accent('› ') + item.text)
    );
  }
  if (item.kind === 'error') {
    return React.createElement(Text, { color: 'red' }, item.text);
  }
  // 'assistant' (default)
  return React.createElement(Text, { color: theme.fg }, item.text);
}

// StatusBar — single row, provider · model · ctx · streaming indicator.
// Kept intentionally minimal in v5.3; token gauges land separately once
// usage metrics flow into state.
export function StatusBar({ provider, model, streaming, ctxUsed, ctxTotal }) {
  const ctx = (ctxUsed != null && ctxTotal != null) ? `${ctxUsed}/${ctxTotal}` : '--';
  const indicator = streaming ? theme.accent('● streaming') : theme.dim('○ idle');
  const prov = provider || '?';
  const mdl = model || '?';
  return React.createElement(
    Box,
    { flexShrink: 0, paddingX: 1 },
    React.createElement(Text, null, `${indicator}  ${prov} · ${mdl}  ctx ${ctx}`)
  );
}

// Exported for tests that want to verify the splash snapshot without a TTY.
export function _renderSplashToString(splashProps) {
  return renderSplashToString(splashProps);
}
