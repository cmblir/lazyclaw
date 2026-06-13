// tests/f-tui-input-ux.test.mjs — Ink REPL input-UX improvements.
//
// Pins five behaviors the v6.3 audit flagged as missing/inconsistent:
//   1. this-session input history (Up/Down recalls submitted prompts);
//   2. mid-line editing in the pure applyKey reducer (Left/Right, Home/End,
//      Ctrl+A/Ctrl+E, Ctrl+K, Ctrl+W, cursor-aware Backspace, insert AT cursor);
//   3. 2-stage Ctrl+C (first press clears the buffer / does not exit);
//   4. Esc-aborted turns emit a visible dim [aborted] marker (run_turn);
//   5. provider errors render in red, not normal amber assistant text (run_turn).
//
// Reducer-level checks are pure (no TTY). Ink-level checks follow the
// ink-testing-library / real-render patterns in the editor/repl tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { makeEditorState, applyKey, Editor } from '../tui/editor.mjs';
import { makeRunTurn } from '../tui/run_turn.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkStdio() {
  const stdout = new PassThrough(); stdout.columns = 80; stdout.rows = 24;
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.setEncoding = () => {};
  stdin.ref = () => {}; stdin.unref = () => {};
  const chunks = [];
  stdout.on('data', (b) => chunks.push(b.toString('utf8')));
  return { stdin, stdout, stderr, frames: () => chunks.join('') };
}

// ─── 2. Mid-line editing (pure reducer) ──────────────────────────────────

test('Ctrl+A jumps to line start; subsequent typing inserts AT the cursor', () => {
  let s = makeEditorState();
  for (const ch of [...'world']) s = applyKey(s, { input: ch, key: {} });
  assert.equal(s.cursor, 5);
  // Ctrl+A → home.
  s = applyKey(s, { input: 'a', key: { ctrl: true } });
  assert.equal(s.cursor, 0, 'Ctrl+A moves the cursor to column 0');
  // Type at the start — must INSERT, not append.
  for (const ch of [...'hello ']) s = applyKey(s, { input: ch, key: {} });
  assert.equal(s.buffer, 'hello world');
  assert.equal(s.cursor, 6);
});

test('Left/Right move the cursor; Backspace deletes AT the cursor', () => {
  let s = makeEditorState();
  for (const ch of [...'abcd']) s = applyKey(s, { input: ch, key: {} });
  s = applyKey(s, { input: '', key: { leftArrow: true } });
  s = applyKey(s, { input: '', key: { leftArrow: true } });
  assert.equal(s.cursor, 2, 'two Lefts land between b and c');
  // Backspace at the cursor removes the char BEFORE it (b), not the end (d).
  s = applyKey(s, { input: '', key: { backspace: true } });
  assert.equal(s.buffer, 'acd');
  assert.equal(s.cursor, 1);
  // Right then End.
  s = applyKey(s, { input: '', key: { rightArrow: true } });
  assert.equal(s.cursor, 2);
  s = applyKey(s, { input: 'e', key: { ctrl: true } }); // Ctrl+E → end
  assert.equal(s.cursor, 3);
});

test('Ctrl+K kills to end of line, Ctrl+W deletes the previous word', () => {
  let s = makeEditorState();
  for (const ch of [...'foo bar baz']) s = applyKey(s, { input: ch, key: {} });
  // Home, then Right ×4 → cursor after "foo ".
  s = applyKey(s, { input: 'a', key: { ctrl: true } });
  for (let i = 0; i < 4; i++) s = applyKey(s, { input: '', key: { rightArrow: true } });
  assert.equal(s.cursor, 4);
  // Ctrl+K kills "bar baz".
  s = applyKey(s, { input: 'k', key: { ctrl: true } });
  assert.equal(s.buffer, 'foo ');
  assert.equal(s.cursor, 4);
  // Type a word then Ctrl+W deletes it.
  for (const ch of [...'qux']) s = applyKey(s, { input: ch, key: {} });
  assert.equal(s.buffer, 'foo qux');
  s = applyKey(s, { input: 'w', key: { ctrl: true } });
  assert.equal(s.buffer, 'foo ');
  assert.equal(s.cursor, 4);
});

test('mid-line edit preserves CJK codepoint cursor units', () => {
  let s = makeEditorState();
  for (const ch of [...'안녕세계']) s = applyKey(s, { input: ch, key: {} });
  assert.equal(s.cursor, 4);
  s = applyKey(s, { input: '', key: { leftArrow: true } });
  s = applyKey(s, { input: '', key: { leftArrow: true } });
  assert.equal(s.cursor, 2, 'cursor is in codepoint units, not display cells');
  s = applyKey(s, { input: '하', key: {} });
  assert.equal(s.buffer, '안녕하세계');
  assert.equal(s.cursor, 3);
});

// ─── 1. This-session input history ────────────────────────────────────────

test('Editor picks up history GROWN after mount (this-session submissions) and Up recalls it', async () => {
  // The audit: <Editor/> snapshots `history` at mount, so this-session
  // submissions appended by the parent (repl) never reach the editor.
  // Inject a sentinel the user never typed in THIS editor, so a stale
  // cumulative-frame match can't pass — only a working prop-sync + Up can.
  const { stdin, stdout, stderr } = mkStdio();
  const SENTINEL = 'RECALLED_SESSION_CMD_XYZ';
  const instance = render(
    React.createElement(Editor, { history: [], onSubmit: async () => {} }),
    { stdout, stdin, stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  try {
    await sleep(40);
    // Parent grows the history list after mount (mirrors repl.state.history).
    instance.rerender(
      React.createElement(Editor, { history: [SENTINEL], onSubmit: async () => {} }),
    );
    await sleep(40);
    // Fresh cumulative capture from here so we only see post-Up frames.
    const tail = [];
    stdout.on('data', (b) => tail.push(b.toString('utf8')));
    stdin.write('\x1b[A'); // Up arrow → recall most recent submission
    await sleep(100);
    const f = tail.join('');
    assert.ok(f.includes(SENTINEL),
      `Up must recall a this-session submission injected after mount; frame: ${JSON.stringify(f.slice(-260))}`);
  } finally {
    try { instance.unmount(); } catch {}
    try { instance.cleanup(); } catch {}
  }
});

// ─── 3. 2-stage Ctrl+C ────────────────────────────────────────────────────

test('first Ctrl+C clears the buffer and does NOT exit; calls onInterrupt', async () => {
  const { stdin, stdout, stderr } = mkStdio();
  let interrupts = 0;
  let exits = 0;
  const instance = render(
    React.createElement(Editor, {
      history: [],
      onSubmit: async () => {},
      onInterrupt: () => { interrupts += 1; },
      onExit: () => { exits += 1; },
    }),
    { stdout, stdin, stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  try {
    stdin.write('half typed');
    await sleep(60);
    stdin.write('\x03'); // Ctrl+C (ETX) — Ink delivers input==='c', key.ctrl
    await sleep(80);
    assert.equal(interrupts, 1, 'first Ctrl+C must fire onInterrupt');
    assert.equal(exits, 0, 'first Ctrl+C must NOT exit');
  } finally {
    try { instance.unmount(); } catch {}
    try { instance.cleanup(); } catch {}
  }
});

test('second Ctrl+C within the window exits', async () => {
  const { stdin, stdout, stderr } = mkStdio();
  let exits = 0;
  const instance = render(
    React.createElement(Editor, {
      history: [],
      onSubmit: async () => {},
      onInterrupt: () => {},
      onExit: () => { exits += 1; },
    }),
    { stdout, stdin, stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  try {
    stdin.write('\x03'); await sleep(40);
    stdin.write('\x03'); await sleep(80);
    assert.equal(exits, 1, 'second Ctrl+C within the window must exit');
  } finally {
    try { instance.unmount(); } catch {}
    try { instance.cleanup(); } catch {}
  }
});

// ─── 4 & 5. run_turn aborted marker + red error ──────────────────────────

function tmpCfg() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-inputux-'));
}

function makeCtx({ provider, messages = [], cfgDir }) {
  return {
    cfg: { provider: 'mock', model: 'mock-m' },
    cfgDir,
    sandboxSpec: null,
    syntheticChatSessionId: 'chat-test-ux',
    getMessages: () => messages,
    getProv: () => provider,
    getActiveProvName: () => 'mock',
    getActiveModel: () => 'mock-m',
    getSessionId: () => null,
    persistTurn: () => {},
    accumulateUsage: () => {},
    resolveAuthKey: () => '',
  };
}

test('Esc-aborted streaming turn emits a visible dim [aborted] marker via writeFn', async () => {
  const cfgDir = tmpCfg();
  const messages = [];
  const provider = {
    name: 'mock',
    async *sendMessage(_messages, opts = {}) {
      for (const ch of 'abcdefghij') {
        if (opts.signal?.aborted) { const e = new Error('aborted'); e.code = 'ABORT'; throw e; }
        await new Promise((r) => setTimeout(r, 5));
        yield ch;
      }
    },
  };
  const writes = [];
  const ctx = makeCtx({ provider, messages, cfgDir });
  const runTurn = makeRunTurn({ ctx, writeFn: (c) => writes.push(c) });
  const ac = new AbortController();
  const p = runTurn('go', ac.signal);
  setTimeout(() => ac.abort(), 12);
  await p;
  await sleep(50);
  const out = writes.join('');
  assert.ok(out.includes('[aborted]'),
    `expected a visible [aborted] marker after Esc-abort, got: ${JSON.stringify(out)}`);
});

test('provider errors are written in the red error style, not normal text', async () => {
  const cfgDir = tmpCfg();
  const messages = [];
  const provider = {
    name: 'mock',
    // eslint-disable-next-line require-yield
    async *sendMessage() { throw new Error('rate limit exceeded'); },
  };
  const writes = [];
  const ctx = makeCtx({ provider, messages, cfgDir });
  const runTurn = makeRunTurn({ ctx, writeFn: (c) => writes.push(c) });
  await runTurn('go', new AbortController().signal);
  await sleep(50);
  const out = writes.join('');
  assert.ok(out.includes('rate limit exceeded'), `error message must be surfaced, got: ${JSON.stringify(out)}`);
  assert.ok(out.includes('\x1b[31m') || out.includes('\x1b[91m'),
    `provider error must carry red ANSI styling, got: ${JSON.stringify(out)}`);
});
