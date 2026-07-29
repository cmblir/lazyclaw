// tui/repl_reset.mjs — pure reducer for the `/new` conversation reset.
//
// Lives in its own file (not repl.mjs) only because repl.mjs is at its
// file-size ceiling (scripts/lint-file-size.mjs). It is the scrollback-clearing
// counterpart to the dispatcher's in-memory reset: /new wiped ctx.setMessages
// but left the <Static/> scrollback intact, so the old conversation stayed on
// screen. This empties the scrollback back to the splash item (the established
// fresh-start look) and drops any in-flight / live-region state.

export function onConversationReset(state) {
  // Keep the splash header so a reset screen looks like a fresh launch, not a
  // blank void. Everything else (user lines, assistant replies, live partial)
  // is discarded.
  const splash = state.scrollback.find((it) => it && it.kind === 'splash') || null;
  return {
    ...state,
    streaming: false,
    controller: null,
    pendingPrepend: null,
    nextTurnFirstMessage: null,
    liveAssistant: '',
    history: [],
    scrollback: splash ? [splash] : [],
    generation: (state.generation || 0) + 1,
    streamStartedAt: null,
    hasStreamedContent: false,
    liveCharCount: 0,
    lastErrorAt: null,
  };
}

// Erase the terminal screen + scrollback buffer. Resetting the React scrollback
// state alone cannot un-print Ink's <Static/> output (it is write-once and
// append-only), so /new must also wipe the physical terminal. `\x1b[3J` drops
// the scrollback buffer so the old conversation can't be scrolled back to.
// `write` is the Ink-provided useStdout().write (clears the live frame first).
export const CLEAR_TERMINAL = '\x1b[2J\x1b[3J\x1b[H';
export function clearTerminalScreen(write) {
  if (typeof write === 'function') {
    try { write(CLEAR_TERMINAL); } catch { /* swallow — stdout may be closed */ }
  }
}
