// tui/repl_reducers.mjs — pure state reducers for the REPL host.
//
// Extracted verbatim from repl.mjs (file-size gate). These are pure
// functions: no shared mutable module state, no JSX. They keep their
// pre-v5.3 shapes — tests/phaseC-repl-interrupt.test.mjs depends on them.
//
// Backward-compat contracts (do not break):
//   - makeReplState()              — still callable with zero args.
//   - onUserInput, onEscape, onTurnComplete, consumeNextTurnFirstMessage
//     keep their pre-v5.3 shapes.

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
    // Bumped by onConversationReset. ReplApp keys its <Static> scrollback by
    // this so a /clear remounts it — Ink's <Static> is write-once, so without
    // a remount the retained splash item is never re-printed.
    generation: 0,
    // When the current turn started (Date.now()), or null while idle. Feeds
    // the StatusBar's elapsed-time readout; cleared on every path back to idle.
    streamStartedAt: null,
    // Latches true on the turn's first chunk, cleared on every path back to
    // idle. liveAssistant is a partial-LINE buffer (onStreamChunk empties it
    // whenever a chunk ends on a newline) so it is unsafe as a "has anything
    // arrived yet" signal — it goes back to '' mid-turn while content the
    // user can already see sits in scrollback. This flag is the real signal.
    hasStreamedContent: false,
    // Total characters streamed so far THIS turn, cleared on every path back
    // to idle (mirrors hasStreamedContent above). Same reason it can't be
    // read off liveAssistant.length: that buffer is flushed to scrollback on
    // every newline, so it only ever reflects the trailing partial line, not
    // the whole turn — using it directly would make the HUD's rate meter
    // collapse toward zero every time a line break lands.
    liveCharCount: 0,
    // Date.now() of the most recent failed turn, or null. Set by
    // onTurnComplete when reason === 'error'; cleared on every other path
    // back to idle (new turn, Esc, or a full conversation reset). Feeds the
    // Editor's border-flash so a failure is visible even if its error text
    // in scrollback has scrolled out of view.
    lastErrorAt: null,
  };
}

export function onUserInput(state, { text, controller }) {
  if (state.streaming && state.controller) {
    // mid-stream interrupt — abort current turn, queue text for next turn.
    // Leaves in-flight turn state (including lastErrorAt) untouched.
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
    streamStartedAt: Date.now(),
    hasStreamedContent: false,
    liveCharCount: 0,
    // A new turn starts without a stale flash from a previous failure.
    lastErrorAt: null,
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
  // telling us to discard, not to keep. An abort is not an error, so the
  // flash is cleared too.
  return {
    ...state,
    streaming: false,
    controller: null,
    pendingPrepend: null,
    liveAssistant: '',
    streamStartedAt: null,
    hasStreamedContent: false,
    liveCharCount: 0,
    lastErrorAt: null,
  };
}

// Stream chunk arrives. Completed lines are committed to the <Static>
// scrollback immediately (so they scroll up ABOVE the sticky editor), and only
// the in-progress trailing partial stays in the live region. Without this, a
// reply taller than the terminal grew the live frame past the viewport and
// spilled BELOW the input box (long orchestrator replies). Chunks without a
// newline still just accumulate (the prior behaviour), so short replies and the
// existing reducer tests are unchanged.
export function onStreamChunk(state, { chunk }) {
  const buf = state.liveAssistant + chunk;
  // Total chars streamed this turn — NOT derived from liveAssistant/buf,
  // both of which get truncated back to the trailing partial line below.
  // Feeds the HUD's live rate meter (tui/status_bar.mjs).
  const liveCharCount = state.liveCharCount + (chunk ? chunk.length : 0);
  const nl = buf.lastIndexOf('\n');
  if (nl < 0) return { ...state, liveAssistant: buf, hasStreamedContent: true, liveCharCount };
  const complete = buf.slice(0, nl);          // one or more whole lines
  const remainder = buf.slice(nl + 1);        // trailing partial (may be '')
  const id = `as-${state.turnCounter}-${state.scrollback.length}`;
  return {
    ...state,
    scrollback: [...state.scrollback, { kind: 'assistant', id, text: complete }],
    liveAssistant: remainder,
    hasStreamedContent: true,
    liveCharCount,
  };
}

export function onTurnComplete(state, { reason, error } = {}) {
  const promoted = state.pendingPrepend;
  const suffix = reason === 'aborted' ? ' [aborted]'
              : reason === 'error'   ? (error ? ` [error: ${error}]` : ' [error]')
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
    streamStartedAt: null,
    hasStreamedContent: false,
    liveCharCount: 0,
    lastErrorAt: reason === 'error' ? Date.now() : null,
  };
}

export function consumeNextTurnFirstMessage(state) {
  const msg = state.nextTurnFirstMessage;
  return [{ ...state, nextTurnFirstMessage: null }, msg];
}
