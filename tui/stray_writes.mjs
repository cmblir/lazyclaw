// tui/stray_writes.mjs — route terminal writes that bypass Ink back through
// Ink's own writer so its redraw bookkeeping stays in sync.
//
// The defect this exists for: Ink repaints by walking the cursor UP
// previousLineCount rows from wherever the cursor currently is
// (node_modules/ink/build/log-update.js) and assumes it is parked directly
// below the frame it drew last. A write that reaches the terminal without
// Ink's knowledge and ENDS A LINE moves the cursor down, so the next erase
// starts that many rows too low and the top rows of the previous frame survive
// on screen — one stale status row per bypassing write. No amount of cursor
// arithmetic in a write shim can repair Ink's line accounting after the fact;
// only Ink can, via
//   writeToStdout(data): log.clear() -> stdout.write(data) -> log(lastOutput)
// which erases the live frame, lets the foreign text land in the scrollback
// above it, and repaints the frame below.
//
// Telling Ink's own frame traffic apart from a foreign write is the hard part,
// because both arrive at the same process.stdout. So Ink is mounted on a
// dedicated proxy stream (makeInkStdout) that raises a flag around its own
// writes; anything else that reaches the patched process.stdout /
// process.stderr while the REPL is mounted is foreign.
//
// Leaf module on purpose: no React, and nothing imported from editor.mjs —
// tui/editor_anchor.mjs consumes this and must stay cycle-free.

// True for the duration of a write Ink itself issued through the proxy.
let inkWriting = false;
// The mounted REPL's useStdout().write, or null when nothing is mounted.
let inkWriter = null;
// True while a foreign chunk is being handed to inkWriter (reentrancy guard).
let redirecting = false;

const INK_PROXY = Symbol.for('lazyclaw.inkStdout');

/**
 * The stream Ink should render into: a thin proxy over `real` that flags Ink's
 * own writes so the stdout/stderr shim can recognise them.
 *
 * `columns`/`rows` are live getters, never copies — a terminal resize mutates
 * them on the underlying stream, and a snapshot taken at mount would freeze the
 * layout at whatever width the terminal happened to have then.
 *
 * @param {{write: Function}} real the stream to render onto (process.stdout)
 */
export function makeInkStdout(real) {
  const proxy = {
    [INK_PROXY]: true,
    write(chunk, ...rest) {
      const outer = inkWriting;
      inkWriting = true;
      // `real.write` is resolved per call, not bound up front:
      // tui/editor_anchor.mjs patches process.stdout.write AFTER this proxy is
      // built and must still see Ink's frames.
      try { return real.write(chunk, ...rest); } finally { inkWriting = outer; }
    },
    get columns() { return real.columns; },
    get rows() { return real.rows; },
    get isTTY() { return real.isTTY; },
    // Ink and ReplApp both subscribe to 'resize' on the stream they render into.
    on(...args) { real.on(...args); return proxy; },
    off(...args) { real.off(...args); return proxy; },
    once(...args) { real.once(...args); return proxy; },
    removeListener(...args) { real.removeListener(...args); return proxy; },
    emit(...args) { return real.emit(...args); },
  };
  return proxy;
}

/** True only for a stream built by makeInkStdout. */
export function isInkStdout(stream) {
  return Boolean(stream && stream[INK_PROXY] === true);
}

/**
 * Register the mounted REPL's Ink writer.
 *
 * `inkStdout` must be the proxy Ink renders into. A mount that supplied its own
 * stream (ink-testing-library, for instance) writes somewhere other than the
 * terminal being shimmed, so redirecting into it would swallow output rather
 * than fix anything — such a mount registers nothing and keeps the old
 * pass-through behaviour.
 *
 * @param {Function|null} fn useStdout().write, or null to clear
 * @param {object} [inkStdout] the stream that Ink renders into
 */
export function setInkWriter(fn, inkStdout) {
  inkWriter = typeof fn === 'function' && isInkStdout(inkStdout) ? fn : null;
}

/** True while Ink is writing one of its own frames through the proxy. */
export function isInkWriting() { return inkWriting; }

/** True while a mounted REPL can absorb foreign writes. */
export function hasInkWriter() { return inkWriter !== null; }

// A chunk of nothing but escape sequences cannot displace a row and has no
// cell content to lose, so it is passed straight through. This is load-bearing,
// not an optimisation: log-update calls cli-cursor, which writes `\x1b[?25l` /
// `\x1b[?25h` directly to process.stderr — outside the proxy — so those arrive
// here looking foreign. Feeding them to writeToStdout would repaint the whole
// frame a second time (Ink's unmount does log.done() -> cliCursor.show() while
// isUnmounted is still false, which would leave a duplicate final frame), and
// at process exit restore-cursor's `\x1b[?25h` would be absorbed by an
// already-unmounted Ink and lost, leaving the terminal cursor hidden.
const ANSI_RE = /\x1b\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]|\x1b[\x40-\x5A\x5C-\x5F]/g;

/**
 * Hand a foreign chunk to Ink's writer so it lands in the scrollback above the
 * live frame instead of inside it.
 *
 * @param {string|Buffer} chunk
 * @returns {boolean} true when Ink consumed the chunk; false when the caller
 *   must write it itself.
 */
export function redirectThroughInk(chunk) {
  // Reentrancy: writeToStdout performs three writes of its own
  // (log.clear() -> stdout.write(data) -> log(lastOutput)). Under the proxy all
  // three are flagged by inkWriting, but a mount that is NOT on the proxy would
  // send them straight back here and recurse without this guard. It also covers
  // the cli-cursor write log-update issues from inside that repaint.
  if (redirecting || inkWriter === null) return false;
  const text = typeof chunk === 'string'
    ? chunk
    : (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : null);
  if (!text || text.replace(ANSI_RE, '') === '') return false;
  redirecting = true;
  try {
    inkWriter(text);
    return true;
  } catch {
    return false; // Ink refused it — let the caller write it raw.
  } finally {
    redirecting = false;
  }
}
