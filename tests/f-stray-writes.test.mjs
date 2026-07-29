// tests/f-stray-writes.test.mjs — pins the pure classification surface of
// tui/stray_writes.mjs: the module that decides, for every write reaching
// the terminal while the chat REPL is mounted, whether that write must be
// redirected through Ink or may pass through raw (on both stdout and
// stderr). A silent regression here reintroduces the duplicated-status-row
// bug this branch exists to fix.
//
// Pure-function unit tests only — no mounting, no useMotion-style timing.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldRedirect,
  hasInkWriter,
  isInkWriting,
  redirectThroughInk,
  isInkStdout,
  makeInkStream,
} from '../tui/stray_writes.mjs';

// ---- PART A: shouldRedirect — printable text ----

test('shouldRedirect: plain text must go through Ink', () => {
  assert.equal(shouldRedirect('hello'), true);
});

test('shouldRedirect: a chunk ending in a newline must go through Ink', () => {
  assert.equal(shouldRedirect('hello\n'), true);
});

// ---- PART B: shouldRedirect — cursor-visibility sequences (load-bearing) ----
//
// cli-cursor writes these straight to process.stderr OUTSIDE the Ink proxy.
// Redirecting them makes Ink repaint its final frame twice on unmount (see
// tui/stray_writes.mjs:102-107).

test('shouldRedirect: cursor-hide (\\x1b[?25l) passes through, not redirected', () => {
  assert.equal(shouldRedirect('\x1b[?25l'), false);
});

test('shouldRedirect: cursor-show (\\x1b[?25h) passes through, not redirected', () => {
  assert.equal(shouldRedirect('\x1b[?25h'), false);
});

// ---- PART C: shouldRedirect — row-moving, escape-only chunks ----

test('shouldRedirect: row-moving escape-only chunks are redirected', () => {
  const rowMoving = [
    '\x1b[5B',       // cursor down
    '\x1b[3A',       // cursor up
    '\x1b[10;1H',    // absolute cursor position
    '\x1b[S',        // scroll up
    '\x1b[T',        // scroll down
    '\x1b[?1049h', '\x1b[?1049l', // alt-screen (xterm)
    '\x1b[?1047h', '\x1b[?1047l', // alt-screen (older xterm)
    '\x1b[?47h', '\x1b[?47l',     // alt-screen (legacy)
  ];
  for (const seq of rowMoving) {
    assert.equal(shouldRedirect(seq), true, `expected redirect for ${JSON.stringify(seq)}`);
  }
});

test('shouldRedirect: a non-row-moving escape-only chunk passes through', () => {
  assert.equal(shouldRedirect('\x1b[0m'), false);
});

test('shouldRedirect: \\x1b[?1048h is not an alt-screen form and passes through', () => {
  assert.equal(shouldRedirect('\x1b[?1048h'), false);
});

// ---- PART D: shouldRedirect — binary inputs ----

test('shouldRedirect: a Buffer of printable bytes is redirected', () => {
  assert.equal(shouldRedirect(Buffer.from('hello', 'utf8')), true);
});

test('shouldRedirect: a Uint8Array of printable bytes is redirected', () => {
  assert.equal(shouldRedirect(new TextEncoder().encode('hello')), true);
});

test('shouldRedirect: a Buffer holding only the lead byte of a split multi-byte codepoint is redirected', () => {
  // 'é' is UTF-8 0xC3 0xA9; this Buffer holds only the lead byte, so decoding
  // it alone yields U+FFFD (a printable cell) — the safe answer is redirect.
  const leadByteOnly = Buffer.from([0xC3]);
  assert.equal(shouldRedirect(leadByteOnly), true);
});

test('shouldRedirect: a Buffer holding only the continuation byte of a split multi-byte codepoint is redirected', () => {
  // The trailing byte of the same 'é' sequence, on its own.
  const continuationByteOnly = Buffer.from([0xA9]);
  assert.equal(shouldRedirect(continuationByteOnly), true);
});

test('shouldRedirect: is stateless — a stranded fragment does not contaminate the next, unrelated chunk', () => {
  // A shared stateful decoder previously let a stranded fragment leak its
  // pending tail into the classification of the NEXT chunk across both
  // streams. Interleave fragments with escape-only chunks that must pass
  // through, and confirm the fragment never flips that answer.
  const leadByteOnly = Buffer.from([0xC3]);
  const continuationByteOnly = Buffer.from([0xA9]);

  assert.equal(shouldRedirect(leadByteOnly), true);
  assert.equal(shouldRedirect('\x1b[0m'), false, 'sgr-reset must still pass through after a lead-byte fragment');
  assert.equal(shouldRedirect('\x1b[?25l'), false, 'cursor-hide must still pass through after a lead-byte fragment');

  assert.equal(shouldRedirect(continuationByteOnly), true);
  assert.equal(shouldRedirect('\x1b[0m'), false, 'sgr-reset must still pass through after a continuation-byte fragment');
  assert.equal(shouldRedirect('\x1b[?25h'), false, 'cursor-show must still pass through after a continuation-byte fragment');
});

// ---- PART E: writer registration state ----

test('hasInkWriter / isInkWriting are false with nothing registered', () => {
  assert.equal(hasInkWriter(), false);
  assert.equal(isInkWriting(), false);
});

test('redirectThroughInk returns false when no writer is registered, so the caller writes it itself', () => {
  assert.equal(redirectThroughInk('some chunk'), false);
});

// ---- PART F: isInkStdout / makeInkStream ----

function fakeStream(overrides = {}) {
  return {
    write() { return true; },
    columns: 80,
    rows: 24,
    isTTY: true,
    on() { return this; },
    off() { return this; },
    once() { return this; },
    removeListener() { return this; },
    emit() { return true; },
    ...overrides,
  };
}

test('isInkStdout: true only for a stream built by makeInkStream', () => {
  const real = fakeStream();
  const proxy = makeInkStream(real);
  assert.equal(isInkStdout(proxy), true);
  assert.equal(isInkStdout(real), false);
  assert.equal(isInkStdout({}), false);
});

test('makeInkStream: columns/rows are live getters, not snapshots taken at construction', () => {
  const real = fakeStream({ columns: 80, rows: 24 });
  const proxy = makeInkStream(real);
  assert.equal(proxy.columns, 80);
  assert.equal(proxy.rows, 24);

  // Simulate a terminal resize on the underlying stream AFTER the proxy
  // was built. A snapshot would freeze the layout at the old size.
  real.columns = 120;
  real.rows = 50;
  assert.equal(proxy.columns, 120);
  assert.equal(proxy.rows, 50);
});
