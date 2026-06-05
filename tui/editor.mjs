// tui/editor.mjs — multiline input state machine (spec §5.8).
//
// Pure-functional core (makeEditorState, applyKey) so it is testable
// without ink stdin. The React component <Editor/> wraps useInput().
import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from './theme.mjs';

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

export function Editor({ history, onSubmit }) {
  const [state, setState] = useState(() => makeEditorState({ history }));
  useInput((input, key) => {
    const next = applyKey(state, { input, key });
    setState(next);
  });
  useEffect(() => {
    if (state.lastSubmit !== null && onSubmit) onSubmit(state.lastSubmit);
  }, [state.lastSubmit]);

  const lines = state.buffer.split('\n');
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    lines.map((ln, i) => React.createElement(Text, { key: i }, i === 0 ? theme.accent('› ') + ln : '  ' + ln))
  );
}
