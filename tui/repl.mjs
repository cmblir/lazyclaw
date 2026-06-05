// tui/repl.mjs — REPL host with mid-stream interrupt-and-redirect
// (spec §5.8). Pure state functions for testability; the React
// mount lives at the bottom and is exercised only when stdin isTTY.
import React, { useState, useEffect } from 'react';
import { Box, useApp } from 'ink';
import { Splash } from './splash.mjs';
import { Editor } from './editor.mjs';

export function makeReplState() {
  return {
    streaming: false,
    controller: null,
    pendingPrepend: null,
    nextTurnFirstMessage: null,
    history: [],
  };
}

export function onUserInput(state, { text, controller }) {
  if (state.streaming && state.controller) {
    // mid-stream interrupt — abort current turn, queue text for next turn.
    try { state.controller.abort(); } catch {}
    return { ...state, pendingPrepend: text };
  }
  // idle — start a new turn.
  return {
    ...state,
    streaming: true,
    controller,
    history: [...state.history, text],
  };
}

export function onEscape(state) {
  if (state.streaming && state.controller) {
    try { state.controller.abort(); } catch {}
  }
  return { ...state, streaming: false, controller: null, pendingPrepend: null };
}

export function onTurnComplete(state, { reason } = {}) {
  void reason;
  const promoted = state.pendingPrepend;
  return {
    ...state,
    streaming: false,
    controller: null,
    pendingPrepend: null,
    nextTurnFirstMessage: promoted,
  };
}

export function consumeNextTurnFirstMessage(state) {
  const msg = state.nextTurnFirstMessage;
  return [{ ...state, nextTurnFirstMessage: null }, msg];
}

// ─── React mount ─────────────────────────────────────────────────────────
// v5.1 TODO (C7 follow-up): replace direct stdout writes in cli.mjs's
// _chatRunTurnFactory with a scrollback ref'd via this component. The
// shape would be an `onOutput` prop that pushes chunks into a `useState`
// array rendered through Ink's <Static items={scrollback}/>. v5.0.10
// ships with raw stdout writes interleaved with Ink (acceptable visual
// jank in exchange for unblocking the chat loop).
export function ReplApp({ splashProps, runTurn }) {
  const [state, setState] = useState(makeReplState);
  const { exit } = useApp();

  async function handleSubmit(text) {
    if (text === '/exit') { exit(); return; }
    const controller = new AbortController();
    setState((s) => onUserInput(s, { text, controller }));
    try {
      await runTurn(text, controller.signal);
      setState((s) => onTurnComplete(s, { reason: 'done' }));
    } catch (err) {
      setState((s) => onTurnComplete(s, { reason: err.name === 'AbortError' ? 'aborted' : 'error' }));
    }
  }

  useEffect(() => {
    const [next, msg] = consumeNextTurnFirstMessage(state);
    if (msg) {
      setState(next);
      handleSubmit(msg);
    }
  }, [state.nextTurnFirstMessage]);

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Splash, splashProps),
    React.createElement(Editor, { history: state.history, onSubmit: handleSubmit })
  );
}
