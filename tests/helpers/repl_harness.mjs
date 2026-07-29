// tests/helpers/repl_harness.mjs — mount the real ReplApp over a fake TTY and
// capture every byte, in order, that reaches the terminal.
//
// Why this swaps the whole `process.stdout` OBJECT instead of handing Ink a
// private stream (what ink-testing-library does):
//
//   In production `render(<ReplApp/>)` is called with no stdout option, so Ink
//   writes to `process.stdout` — the SAME object tui/editor_anchor.mjs
//   monkey-patches. That patch is the entire compensation mechanism: it
//   prepends `\x1b[<offset>B\r` to any chunk starting with `\x1b[2K` (Ink's
//   eraseLines) so the erase walks up from the row Ink expects rather than from
//   the row the IME cursor anchor parked on. Give Ink a separate stream and the
//   shim never sees Ink's writes at all — you would get "corruption" that
//   cannot happen in the real app. So the harness keeps ONE stream: it installs
//   a fake TTY AS `process.stdout`, and the anchor shim installs itself on top
//   of that fake exactly as it does on the real stream in production.
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
 * @param {{columns?: number, rows?: number}} geom fake terminal geometry
 */
export function mountRepl(props = {}, { columns = 100, rows = 40 } = {}) {
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
  delete process.env.LAZYCLAW_ALT;
  delete process.env.LAZYCLAW_NO_CURSOR_ANCHOR;
  // Force the anchor shim to re-install over THIS mount's stdout; the module
  // singleton would otherwise still hold a previous mount's stream.
  anchorState.offset = 0;
  anchorState.shimmed = false;

  function restore() {
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
      // Production options (commands/chat.mjs:332) minus patchConsole, which
      // would hijack the test runner's console. patchConsole only routes
      // console.* through Ink's SAFE writeToStdout path anyway — the unsafe
      // direct `process.stdout.write` callsites this bug is about are
      // unaffected by it.
      { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
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
      restore();
    },
  };
}
