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
// because both arrive at the same process.stdout. So Ink is mounted on
// dedicated proxy streams (makeInkStream, for BOTH its stdout and its stderr)
// that raise a flag around its own writes; anything else that reaches the
// patched process.stdout / process.stderr while the REPL is mounted is foreign.
//
// Leaf module on purpose: no React, and nothing imported from editor.mjs —
// tui/editor_anchor.mjs consumes this and must stay cycle-free.

// True for the duration of a write Ink itself issued through a proxy.
let inkWriting = false;
// The mounted REPL's useStdout().write, or null when nothing is mounted.
let inkWriter = null;
// True while a foreign chunk is being handed to inkWriter (reentrancy guard).
let redirecting = false;
// Liveness probe: set by a proxy write, checked after inkWriter returns.
let sawInkWrite = false;

const INK_PROXY = Symbol.for('pompos.inkStdout');

/**
 * One of the streams Ink renders into — pass it as BOTH the `stdout` and the
 * `stderr` render option. A thin proxy over `real` that flags Ink's own writes
 * so the stdout/stderr shim can recognise them.
 *
 * `columns`/`rows` are live getters, never copies — a terminal resize mutates
 * them on the underlying stream, and a snapshot taken at mount would freeze the
 * layout at whatever width the terminal happened to have then.
 *
 * @param {{write: Function}} real the stream to render onto (process.stdout)
 */
export function makeInkStream(real) {
  const proxy = {
    [INK_PROXY]: true,
    write(chunk, ...rest) {
      const outer = inkWriting;
      inkWriting = true;
      sawInkWrite = true;
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

/** True only for a stream built by makeInkStream. */
export function isInkStdout(stream) {
  return Boolean(stream && stream[INK_PROXY] === true);
}

/**
 * Register the mounted REPL's Ink writer.
 *
 * `inkStdout` must be the proxy Ink renders into. A mount that supplied its own
 * stream (ink-testing-library, for instance) writes somewhere other than the
 * terminal being shimmed, so redirecting into it would swallow output rather
 * than fix anything — such a mount is ignored. Ignored, not cleared: it must not
 * be able to deregister a live REPL that is mounted elsewhere in the process.
 *
 * @param {Function|null} fn useStdout().write, or null to deregister
 * @param {object} [inkStdout] the stream that Ink renders into
 */
export function setInkWriter(fn, inkStdout) {
  if (typeof fn !== 'function') { inkWriter = null; return; }
  if (!isInkStdout(inkStdout)) return;
  inkWriter = fn;
}

/** True while Ink is writing one of its own frames through a proxy. */
export function isInkWriting() { return inkWriting; }

/** True while a mounted REPL can absorb foreign writes. */
export function hasInkWriter() { return inkWriter !== null; }

// The one escape pair Ink emits OUTSIDE its proxies: log-update calls cli-cursor
// (which writes straight to process.stderr) before stream.write, and again from
// log.done() during unmount. Redirecting these is actively wrong — the unmount
// one runs while isUnmounted is still false, so it would repaint the whole final
// frame a second time, and restore-cursor's exit-time show would be absorbed by
// an already-unmounted Ink and lost, leaving the terminal cursor hidden.
const CURSOR_VISIBILITY_RE = /^(?:\x1b\[\?25[lh])+$/;

// Escape sequences, used to find the chunks that carry no printable cell.
const ANSI_RE = /\x1b\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]|\x1b[\x40-\x5A\x5C-\x5F]/g;

// "Escape-only" is NOT the same as "harmless". These carry no printable cell yet
// still move the cursor's row or destroy the frame, so passing one through would
// recreate the very desync this module exists to prevent. CSI finals: A/B cursor
// up-down, E/F next-previous line, H/f absolute position, d/e row position,
// J erase-in-display, L/M insert-delete line, S/T scroll, r scroll region; plus
// the alternate-screen switch, and the two-character IND/NEL/RI/RIS and
// cursor save-restore escapes.
const ROW_MOVING_RE = /\x1b\[[\x30-\x3F]*[\x20-\x2F]*[ABEFHJLMSTdefr]|\x1b\[\?(?:1049|1047|47)[hl]|\x1b[DEMc78]/;

// Decoding happens ONLY to classify; the original chunk is what gets handed to
// Ink, so a Buffer is never re-encoded.
//
// Stateless on purpose. A shared StringDecoder would carry the tail of a
// multi-byte character split across two chunks into the classification of the
// NEXT, unrelated chunk — and since this module classifies both stdout and
// stderr, that contamination crossed streams. Decoding each chunk in isolation
// means a chunk cut mid-codepoint yields U+FFFD, which reads as a printable
// cell and so classifies as "must go through Ink": the safe answer. The cost is
// cosmetic mojibake on a fragmented write; the benefit is that no later chunk
// is ever misclassified because of an earlier one.
function decodeForClassification(chunk) {
  if (typeof chunk === 'string') return chunk;
  if (!ArrayBuffer.isView(chunk)) return '';
  return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8');
}

/**
 * Content policy: does this chunk need Ink's safe write path?
 *
 * Callers MUST gate redirectThroughInk on this — it is deliberately split out so
 * the anchor shim can decide whether to consume its pending cursor offset before
 * committing to a redirect.
 *
 * @param {string|Buffer|Uint8Array} chunk
 */
export function shouldRedirect(chunk) {
  const text = decodeForClassification(chunk);
  if (text === '') return false;
  if (CURSOR_VISIBILITY_RE.test(text)) return false;
  // Printable cells: must go through Ink or they land inside the live frame.
  if (text.replace(ANSI_RE, '') !== '') return true;
  // No printable cells — only worth redirecting if it would move the cursor.
  return ROW_MOVING_RE.test(text);
}

/**
 * Delivery: hand an already-classified foreign chunk to Ink's writer so it lands
 * in the scrollback above the live frame instead of inside it.
 *
 * @param {string|Buffer|Uint8Array} chunk as given to the shimmed stream
 * @returns {boolean} true when Ink actually wrote the chunk; false when the
 *   caller must write it itself.
 */
export function redirectThroughInk(chunk) {
  // Reentrancy: writeToStdout performs three writes of its own
  // (log.clear() -> stdout.write(data) -> log(lastOutput)). Under the proxy all
  // three are flagged by inkWriting, but a mount that is NOT on the proxy would
  // send them straight back here and recurse without this guard. It also covers
  // the cli-cursor write log-update issues from inside that repaint.
  if (redirecting || inkWriter === null) return false;
  sawInkWrite = false;
  redirecting = true;
  try {
    // The ORIGINAL chunk, not a decoded copy: writeToStdout passes `data`
    // straight to stdout.write, so a Buffer survives byte-for-byte.
    inkWriter(chunk);
    // writeToStdout returns having written NOTHING when Ink is already unmounted
    // (ink.js:142-144), and setInkWriter(null) runs in a React effect cleanup
    // that flushes a macrotask later — or never, on the signal-exit path. Every
    // live branch of writeToStdout writes to options.stdout at least once, so an
    // untouched flag means the chunk was dropped, not delivered: report that and
    // let the caller write it raw rather than swallowing it.
    return sawInkWrite;
  } catch {
    return false; // Ink refused it — let the caller write it raw.
  } finally {
    redirecting = false;
  }
}
