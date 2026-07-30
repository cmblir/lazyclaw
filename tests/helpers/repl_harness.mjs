// tests/helpers/repl_harness.mjs — mount the real ReplApp over a fake TTY and
// capture every byte, in order, that reaches the terminal.
//
// Why this swaps the whole `process.stdout` OBJECT instead of handing Ink a
// private stream (what ink-testing-library does):
//
//   In production `render(<ReplApp/>)` mounts Ink on
//   `makeInkStream(process.stdout)` — a thin proxy whose `write` forwards to
//   `process.stdout`, the SAME object tui/editor_anchor.mjs monkey-patches. That
//   patch is the entire compensation mechanism: it prepends `\x1b[<offset>B\r`
//   to Ink's frame chunks so the erase walks up from the row Ink expects rather
//   than from the row the IME cursor anchor parked on, and it hands any write
//   that BYPASSES Ink to Ink's own writer instead. Give Ink an unrelated stream
//   and the shim never sees Ink's writes at all — you would get "corruption"
//   that cannot happen in the real app. So the harness keeps ONE underlying
//   stream per fd: it installs fake TTYs AS `process.stdout` / `process.stderr`,
//   mounts Ink on `makeInkStream(thatFake)` for BOTH exactly as production does,
//   and the anchor shim installs itself on top of the fakes as it does on the
//   real streams.
//
//   `process.stderr` is faked into the same byte array too, because in a real
//   terminal stderr lands on the same screen and the bug is an ordering problem
//   between writers.
//
//   Swapping the property (rather than just `process.stdout.write`) is what
//   keeps node's own test reporter out of the capture: the reporter pipes to
//   the stream object it grabbed at startup, so it keeps writing to the real
//   fd while the app under test writes to the fake.
//
// ink-testing-library cannot be used here for a second reason: it mounts with
// `debug: true`, which makes Ink emit `fullStaticOutput + output` on every
// render and bypass log-update entirely. Its `frames` are full snapshots, not
// the incremental erase/redraw stream this bug lives in.
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import React from 'react';
import { ReplApp } from '../../tui/repl.mjs';
import { anchorState } from '../../tui/editor_anchor.mjs';
import { makeInkStream, setInkWriter } from '../../tui/stray_writes.mjs';

function fakeTty(sink, { columns, rows } = {}) {
  const s = new EventEmitter();
  s.isTTY = true;
  if (columns != null) s.columns = columns;
  if (rows != null) s.rows = rows;
  s.write = (chunk) => { sink.push(String(chunk)); return true; };
  return s;
}

// Mirrors ink-testing-library's Stdin: enough of a TTY for Ink's useInput.
function fakeStdin() {
  const s = new EventEmitter();
  s.isTTY = true;
  s.data = null;
  s.setEncoding = () => {};
  s.setRawMode = () => {};
  s.resume = () => {};
  s.pause = () => {};
  s.ref = () => {};
  s.unref = () => {};
  s.read = () => { const d = s.data; s.data = null; return d; };
  s.write = (data) => { s.data = data; s.emit('readable'); s.emit('data', data); };
  return s;
}

function swap(key, value) {
  const prev = Object.getOwnPropertyDescriptor(process, key);
  Object.defineProperty(process, key, { value, configurable: true, enumerable: true, writable: true });
  return () => { Object.defineProperty(process, key, prev); };
}

/**
 * Mount ReplApp the way commands/chat.mjs does, over a faked-TTY process.stdout.
 *
 * @param {object} props extra ReplApp props (merged over the defaults)
 * @param {{columns?: number, rows?: number, alt?: boolean}} geom fake terminal
 *   geometry. `alt: true` sets LAZYCLAW_ALT=1 (instead of deleting it) so
 *   computeAltEnabled (tui/repl_altbuffer.mjs) resolves to the alt-buffer
 *   layout arm. Default stays non-alt (env var deleted), matching prior
 *   behavior exactly.
 *
 *   KNOWN LEAK, `alt: true` only: unmounting an alt-mode instance emits
 *   `\x1b[?1049l\x1b[?25h` to the REAL process.stdout a tick later — so it
 *   lands in piped/redirected output (CI logs) too, not just an interactive
 *   terminal. Cause: FullScreen's alt-buffer-exit cleanup in
 *   tui/repl_altbuffer.mjs writes to `process.stdout` directly and runs on
 *   React's passive-effect tick, which is AFTER unmount() has synchronously
 *   restored the real stream. Assertions are unaffected (they all complete
 *   before unmount), and the bytes are inert on the primary buffer. Left
 *   as-is deliberately: fixing it means either changing that production
 *   cleanup or deferring restore() across a tick, and restore() ordering is
 *   shared by every mountRepl caller. If you add a second `alt: true` test,
 *   you inherit this — it is noise in the log, not a broken assertion.
 */
export function mountRepl(props = {}, { columns = 100, rows = 40, alt = false } = {}) {
  const bytes = [];
  const stdout = fakeTty(bytes, { columns, rows });
  const stderr = fakeTty(bytes);
  const stdin = fakeStdin();

  const saved = {
    offset: anchorState.offset,
    shimmed: anchorState.shimmed,
    envAlt: process.env.LAZYCLAW_ALT,
    envNoAnchor: process.env.LAZYCLAW_NO_CURSOR_ANCHOR,
  };
  const restoreStdout = swap('stdout', stdout);
  const restoreStderr = swap('stderr', stderr);

  // Pin the configuration under test: the PRIMARY terminal buffer (Ink
  // <Static> scrollback, the default) with the IME cursor anchor ON. Both are
  // env-switchable, so a developer's shell must not change what tests assert.
  // `alt: true` opts into the alt-buffer arm instead (LAZYCLAW_ALT=1).
  if (alt) process.env.LAZYCLAW_ALT = '1';
  else delete process.env.LAZYCLAW_ALT;
  delete process.env.LAZYCLAW_NO_CURSOR_ANCHOR;
  // Force the anchor shim to re-install over THIS mount's stdout; the module
  // singleton would otherwise still hold a previous mount's stream.
  anchorState.offset = 0;
  anchorState.shimmed = false;

  function restore() {
    // Deregister explicitly rather than trusting ReplApp's effect cleanup: that
    // cleanup only runs if React actually unmounts, so a mount that threw or an
    // unmount() that failed would leave this mount's writer registered and let
    // the NEXT test's stray writes be handed to a dead Ink instance.
    setInkWriter(null);
    restoreStdout();
    restoreStderr();
    anchorState.offset = saved.offset;
    anchorState.shimmed = saved.shimmed;
    restoreEnv('LAZYCLAW_ALT', saved.envAlt);
    restoreEnv('LAZYCLAW_NO_CURSOR_ANCHOR', saved.envNoAnchor);
  }

  function restoreEnv(key, value) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  let instance;
  try {
    instance = render(
      React.createElement(ReplApp, { runTurn: async () => {}, ...props }),
      // Production options (commands/chat.mjs) minus patchConsole, which would
      // hijack the test runner's console. patchConsole only routes console.*
      // through Ink's SAFE writeToStdout path anyway — the unsafe direct
      // `process.stdout.write` callsites this bug is about are unaffected by it.
      {
        stdout: makeInkStream(stdout),
        stderr: makeInkStream(stderr),
        stdin,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
  } catch (err) {
    restore();
    throw err;
  }

  return {
    bytes,
    stdin,
    stdout,
    stderr,
    instance,
    type: (text) => { stdin.write(text); },
    // How many rows the editor's IME anchor has parked the cursor up by, with
    // no Ink redraw having consumed it yet. Tests assert this is non-zero
    // before a bypass write so the scenario can't silently stop reproducing.
    anchorOffset: () => anchorState.offset,
    // Let React flush effects + Ink flush its throttled log (onRender is
    // throttled at 32ms with a trailing call).
    settle: async (ms = 60) => { await new Promise((r) => setTimeout(r, ms)); },
    unmount: () => {
      try { instance.unmount(); } catch { /* already gone */ }
      // Ink caches instances by stdout object; cleanup() drops this mount's
      // entry so the map does not grow across a file's worth of tests.
      try { instance.cleanup(); } catch { /* ignore */ }
      // restore() is synchronous and runs BEFORE React's passive-effect
      // cleanup. For `alt: true` mounts that means FullScreen's alt-exit
      // escape lands on the real stdout — see the KNOWN LEAK note on
      // mountRepl. Do not "fix" that by deferring this call: every caller
      // relies on the env/stream restore having happened by the time
      // unmount() returns.
      restore();
    },
  };
}
