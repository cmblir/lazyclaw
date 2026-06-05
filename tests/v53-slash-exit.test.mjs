// tests/v53-slash-exit.test.mjs — `/exit` (and friends) must reach
// handleSubmit and unmount the Ink REPL.
//
// Regression: the slash-popup branch in tui/editor.mjs swallowed Enter
// when the buffer was exactly a complete command (e.g. '/exit') because
// the "first Enter fills, second Enter runs" rule was applied
// unconditionally. fillSlashCommand replaced the buffer with '/exit '
// (trailing space) and `return`ed before applyKey could set
// lastSubmit, so onSubmit never fired and the REPL stayed alive.
//
// What we pin here:
//   1. Pure: filterSlashCommands('/exit', SLASH_COMMANDS) returns a
//      single match whose cmd === '/exit' (i.e. the popup IS open).
//   2. Editor: the Enter branch of the slash-popup contract falls
//      through to applyKey when the buffer already matches the picked
//      command verbatim — proven by mounting <Editor/> via Ink with a
//      faked stdin, writing '\r', and asserting onSubmit was called
//      with '/exit'.
//   3. ReplApp host: when `slashCommands` contains '/exit' and a real
//      Ink mount of <ReplApp/> receives Enter on a '/exit' buffer, the
//      Ink app unmounts (waitUntilExit resolves). This is the end-to-end
//      smoke test for the bug.
//   4. handleSubmit normalizes trailing whitespace, so a leftover
//      '/exit ' (from a popup auto-fill) still triggers exit.
//   5. Non-exit slash commands (e.g. '/help') are forwarded to the
//      caller's onSlashCommand dispatcher (not runTurn), so the legacy
//      handleSlash wiring in cli.mjs continues to fire its handlers.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { filterSlashCommands } from '../tui/slash_popup.mjs';
import { SLASH_COMMANDS } from '../tui/slash_commands.mjs';
import { Editor } from '../tui/editor.mjs';
import { ReplApp } from '../tui/repl.mjs';

// ─── Helpers ─────────────────────────────────────────────────────────────

function mkStdio({ columns = 80 } = {}) {
  const stdout = new PassThrough();
  stdout.columns = columns;
  stdout.rows = 24;
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  // Pretend TTY so Ink's useInput hook can call setRawMode without
  // throwing. We provide no-op ref/unref/setRawMode/setEncoding so the
  // App component's raw-mode wiring (App.js:104+) succeeds.
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.setEncoding = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  // PassThrough already implements 'readable' / 'data' event semantics.
  // Ink subscribes via stdin.addListener('readable', ...) and then
  // reads via stdin.read() — both work on PassThrough out of the box.

  // Capture frames so we can assert on output if needed.
  const chunks = [];
  stdout.on('data', (b) => chunks.push(b.toString('utf8')));
  return { stdin, stdout, stderr, frames: () => chunks.join('') };
}

// ─── 1. Pure filter — `/exit` is a real, single-match command ────────────

test('filterSlashCommands("/exit") returns exactly one match — the popup IS open', () => {
  const matches = filterSlashCommands('/exit', SLASH_COMMANDS);
  // Prefix-match against the catalog: only '/exit' starts with '/exit'.
  assert.equal(matches.length, 1, `expected 1 match, got ${matches.map(m => m.cmd).join(',')}`);
  assert.equal(matches[0].cmd, '/exit');
});

test('filterSlashCommands("/quit") returns exactly one match — /quit', () => {
  const matches = filterSlashCommands('/quit', SLASH_COMMANDS);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].cmd, '/quit');
});

// ─── 2. Editor: Enter on a verbatim buffer falls through to onSubmit ────

test('Editor: Enter on a buffer that exactly matches the picked slash cmd calls onSubmit', async () => {
  const { stdin, stdout, stderr } = mkStdio();
  let submitted = null;
  const instance = render(
    React.createElement(Editor, {
      history: [],
      onSubmit: (text) => { submitted = text; },
      // Open popup with /exit as the only suggestion AND pre-fill the
      // buffer via onBufferChange piping. Because <Editor/>'s buffer
      // state is internal we instead pre-type '/exit' through stdin so
      // applyKey populates state.buffer before the slash-open check.
      slashSuggestions: [{ cmd: '/exit', help: 'leave the chat' }],
      slashSelectedIndex: 0,
      onSlashMove: () => {},
      onSlashDismiss: () => {},
    }),
    { stdout, stdin, stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  try {
    // Type "/exit" → applyKey appends each char. The slash-popup branch
    // catches arrow keys / Tab / Enter, but printable chars fall through
    // to applyKey (see editor.mjs:152 "Anything else falls through").
    stdin.write('/exit');
    // Give React a tick to flush the buffer state.
    await new Promise((r) => setTimeout(r, 30));
    // Press Enter — buffer === picked.cmd, so the editor must fall
    // through to applyKey, which sets lastSubmit, which fires onSubmit
    // via useEffect.
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(submitted, '/exit',
      `expected onSubmit('/exit'), got ${JSON.stringify(submitted)}`);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

// ─── 3. ReplApp host: '/exit' Enter unmounts the Ink app ─────────────────

test('ReplApp: typing /exit + Enter unmounts the Ink app (waitUntilExit resolves)', async () => {
  const { stdin, stdout, stderr } = mkStdio();
  let runTurnCalledWith = null;
  const instance = render(
    React.createElement(ReplApp, {
      splashProps: {
        provider: 'mock', model: 'm',
        version: '5.x', cwd: '/tmp', tools: [], skills: [],
      },
      runTurn: async (text) => { runTurnCalledWith = text; },
    }),
    { stdout, stdin, stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
  );

  // Type /exit then press Enter.
  stdin.write('/exit');
  await new Promise((r) => setTimeout(r, 30));
  stdin.write('\r');

  // The Ink app must unmount within a short window. We race
  // waitUntilExit against a 1 s timeout — if waitUntilExit wins, the
  // /exit dispatch worked end-to-end.
  const exited = await Promise.race([
    instance.waitUntilExit().then(() => 'exited'),
    new Promise((r) => setTimeout(() => r('timeout'), 1500)),
  ]);

  try {
    assert.equal(exited, 'exited',
      `expected ReplApp to unmount on /exit, got ${exited}`);
    assert.equal(runTurnCalledWith, null,
      `runTurn must not be invoked for /exit, got ${JSON.stringify(runTurnCalledWith)}`);
  } finally {
    try { instance.unmount(); } catch {}
    try { instance.cleanup(); } catch {}
  }
});

test('ReplApp: /quit also unmounts the Ink app', async () => {
  const { stdin, stdout, stderr } = mkStdio();
  const instance = render(
    React.createElement(ReplApp, {
      splashProps: {
        provider: 'mock', model: 'm',
        version: '5.x', cwd: '/tmp', tools: [], skills: [],
      },
      runTurn: async () => {},
    }),
    { stdout, stdin, stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
  );

  stdin.write('/quit');
  await new Promise((r) => setTimeout(r, 30));
  stdin.write('\r');

  const exited = await Promise.race([
    instance.waitUntilExit().then(() => 'exited'),
    new Promise((r) => setTimeout(() => r('timeout'), 1500)),
  ]);

  try {
    assert.equal(exited, 'exited',
      `expected ReplApp to unmount on /quit, got ${exited}`);
  } finally {
    try { instance.unmount(); } catch {}
    try { instance.cleanup(); } catch {}
  }
});

// ─── 4. Trailing-whitespace normalization ────────────────────────────────

test("Editor: '/exit ' (with trailing space from a fill) still submits as /exit", async () => {
  // This pins the second half of the diagnosis — the leftover trailing
  // space from fillSlashCommand must not break the /exit match. The
  // host (ReplApp.handleSubmit) trims trailing whitespace; here we just
  // ensure the editor reaches onSubmit at all on Enter when the buffer
  // is the command + a trailing space.
  const { stdin, stdout, stderr } = mkStdio();
  let submitted = null;
  const instance = render(
    React.createElement(Editor, {
      history: [],
      onSubmit: (text) => { submitted = text; },
      slashSuggestions: [{ cmd: '/exit', help: 'leave the chat' }],
      slashSelectedIndex: 0,
      onSlashMove: () => {},
      onSlashDismiss: () => {},
    }),
    { stdout, stdin, stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  try {
    stdin.write('/exit ');
    await new Promise((r) => setTimeout(r, 30));
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 50));
    // The editor must have called onSubmit with '/exit ' (the host then
    // trims). It must NOT have intercepted Enter and silently re-filled.
    assert.equal(submitted, '/exit ',
      `expected onSubmit('/exit '), got ${JSON.stringify(submitted)}`);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test('ReplApp: /exit with trailing whitespace unmounts (host normalizes)', async () => {
  const { stdin, stdout, stderr } = mkStdio();
  let runTurnCalledWith = null;
  const instance = render(
    React.createElement(ReplApp, {
      splashProps: {
        provider: 'mock', model: 'm',
        version: '5.x', cwd: '/tmp', tools: [], skills: [],
      },
      runTurn: async (text) => { runTurnCalledWith = text; },
    }),
    { stdout, stdin, stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
  );

  stdin.write('/exit ');
  await new Promise((r) => setTimeout(r, 30));
  stdin.write('\r');

  const exited = await Promise.race([
    instance.waitUntilExit().then(() => 'exited'),
    new Promise((r) => setTimeout(() => r('timeout'), 1500)),
  ]);
  try {
    assert.equal(exited, 'exited',
      `expected ReplApp to unmount on '/exit ' (trailing space), got ${exited}`);
    assert.equal(runTurnCalledWith, null,
      `runTurn must not be invoked for /exit, got ${JSON.stringify(runTurnCalledWith)}`);
  } finally {
    try { instance.unmount(); } catch {}
    try { instance.cleanup(); } catch {}
  }
});

// ─── 5. Other slash commands route through onSlashCommand, not runTurn ──

test('ReplApp: non-exit slash command (e.g. /help) is dispatched to onSlashCommand', async () => {
  const { stdin, stdout, stderr } = mkStdio();
  let runTurnCalls = 0;
  let slashCalls = [];
  const instance = render(
    React.createElement(ReplApp, {
      splashProps: {
        provider: 'mock', model: 'm',
        version: '5.x', cwd: '/tmp', tools: [], skills: [],
      },
      runTurn: async () => { runTurnCalls += 1; },
      onSlashCommand: async (line) => {
        slashCalls.push(line);
        return 'slash result\n';
      },
    }),
    { stdout, stdin, stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
  );

  try {
    stdin.write('/help');
    await new Promise((r) => setTimeout(r, 30));
    stdin.write('\r');
    // Give React a tick to flush the async dispatcher.
    await new Promise((r) => setTimeout(r, 80));

    assert.deepEqual(slashCalls, ['/help'],
      `expected onSlashCommand(['/help']), got ${JSON.stringify(slashCalls)}`);
    assert.equal(runTurnCalls, 0,
      `runTurn must not be called for slash commands, got ${runTurnCalls} calls`);
  } finally {
    try { instance.unmount(); } catch {}
    try { instance.cleanup(); } catch {}
  }
});

test('ReplApp: onSlashCommand returning "EXIT" unmounts the app (slash handler can shut down)', async () => {
  const { stdin, stdout, stderr } = mkStdio();
  const instance = render(
    React.createElement(ReplApp, {
      splashProps: {
        provider: 'mock', model: 'm',
        version: '5.x', cwd: '/tmp', tools: [], skills: [],
      },
      runTurn: async () => {},
      // Mimic cli.mjs's handleSlash, which returns 'EXIT' for /exit.
      onSlashCommand: async () => 'EXIT',
    }),
    { stdout, stdin, stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
  );

  // Pick a non-/exit slash so the inline /exit shortcut doesn't fire
  // — we want to exercise the EXIT return path.
  stdin.write('/help');
  await new Promise((r) => setTimeout(r, 30));
  stdin.write('\r');

  const exited = await Promise.race([
    instance.waitUntilExit().then(() => 'exited'),
    new Promise((r) => setTimeout(() => r('timeout'), 1500)),
  ]);
  try {
    assert.equal(exited, 'exited',
      `expected ReplApp to unmount when onSlashCommand returns 'EXIT', got ${exited}`);
  } finally {
    try { instance.unmount(); } catch {}
    try { instance.cleanup(); } catch {}
  }
});
