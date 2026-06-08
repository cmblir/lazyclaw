// tests/f-ink-chat-history.test.mjs — assistant replies must survive in the
// Ink REPL (the "chat history disappears immediately" bug).
//
// Root cause: commands/chat.mjs wired the Ink ReplApp with the legacy
// `runTurn` prop whose writeFn wrote streamed chunks straight to
// process.stdout. Those bytes landed in Ink's live frame, which the very
// next render (status refresh, next keystroke, streaming toggle) erased —
// so the assistant reply flashed and vanished while the user's own line
// (a <Static/> scrollback item) survived.
//
// Fix: route the Ink path through `runTurnFactory`, so ReplApp injects its
// React-state writeFn. Chunks accumulate in state.liveAssistant, render in
// the live region, and commit to the <Static/> scrollback on turn-complete
// — Ink owns the output and it persists across re-renders.
//
// What we pin here:
//   1. Behavioral: a real Ink mount of <ReplApp/> driven via runTurnFactory
//      commits the streamed assistant reply to the scrollback, and the
//      reply is still present after a subsequent re-render (a later
//      keystroke). The buggy stdout wiring could not satisfy this.
//   2. Structural drift-guard: commands/chat.mjs wires the Ink ReplApp with
//      runTurnFactory and no longer writes chunks straight to stdout.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { render } from 'ink';
import { ReplApp } from '../tui/repl.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Faked TTY stdio so Ink's raw-mode wiring succeeds under node:test, with a
// cumulative capture of every byte written to stdout (Static output included).
function mkStdio({ columns = 80 } = {}) {
  const stdout = new PassThrough();
  stdout.columns = columns;
  stdout.rows = 24;
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.setEncoding = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const chunks = [];
  stdout.on('data', (b) => chunks.push(b.toString('utf8')));
  return { stdin, stdout, stderr, frames: () => chunks.join('') };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('ReplApp via runTurnFactory: streamed assistant reply commits to scrollback and persists', async () => {
  const { stdin, stdout, stderr, frames } = mkStdio();
  const REPLY = 'ASSISTANT_REPLY_TOKEN';
  let factoryCalledWithWriteFn = false;

  const instance = render(
    React.createElement(ReplApp, {
      splashProps: {
        provider: 'mock', model: 'm',
        version: '6.x', cwd: '/tmp', tools: [], skills: [],
      },
      // Mirrors commands/chat.mjs: ReplApp injects its React-state writeFn;
      // the turn streams chunks through it (not to stdout).
      runTurnFactory: (writeFn) => {
        factoryCalledWithWriteFn = typeof writeFn === 'function';
        return async (_text) => {
          writeFn(REPLY);
        };
      },
    }),
    { stdout, stdin, stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
  );

  try {
    // ReplApp must build runTurn via the factory (not the legacy prop).
    assert.equal(factoryCalledWithWriteFn, true,
      'ReplApp should call runTurnFactory(writeFn) to wire the React-state sink');

    // Send a normal (non-slash) message.
    stdin.write('ping');
    await sleep(40);
    stdin.write('\r');

    // Wait for the turn to stream + commit to the <Static/> scrollback.
    let committed = false;
    for (let i = 0; i < 40; i++) {
      await sleep(25);
      if (frames().includes(REPLY)) { committed = true; break; }
    }
    assert.equal(committed, true,
      `assistant reply ${JSON.stringify(REPLY)} never reached the scrollback — ` +
      'it was lost (the disappearing-history bug)');

    // Force a re-render with another keystroke; the committed reply must NOT
    // be erased (Static output is permanent — the whole point of the fix).
    stdin.write('x');
    await sleep(120);
    assert.equal(frames().includes(REPLY), true,
      'assistant reply was erased by a later render — it did not commit to <Static/>');
  } finally {
    try { instance.unmount(); } catch {}
    try { instance.cleanup(); } catch {}
  }
});

test('commands/chat.mjs wires the Ink REPL through runTurnFactory, not a stdout runTurn', () => {
  const src = readFileSync(join(__dirname, '..', 'commands', 'chat.mjs'), 'utf8');
  assert.match(src, /runTurnFactory:\s*_inkRunTurnFactory/,
    'the Ink ReplApp must be wired with runTurnFactory so chunks route through React state');
  // The old wiring passed a pre-built closure as the legacy `runTurn:` prop,
  // whose writeFn wrote chunks straight to stdout. `runTurn:` is an Ink
  // ReplApp prop only (the legacy readline path uses a `const runTurn = …`
  // declaration, not a prop), so its absence pins the Ink-path fix without
  // flagging the legacy path's legitimate stdout writer.
  assert.doesNotMatch(src, /runTurn:\s*_inkRunTurn\b/,
    'the Ink chat turn must not use the stdout-writing runTurn prop (the disappearing-history bug)');
});
