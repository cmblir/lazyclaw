// tests/f-editor-cursor-glyph.test.mjs — the input box shows a visible caret
// at ALL times, including before anything is typed. The real terminal cursor
// is anchored for IME pre-edit, but renders triggered by OTHER components
// used to leave the box apparently cursor-less while idle; an inverse-video
// cell at the cursor position keeps it visible regardless.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { Editor } from '../tui/editor.mjs';

const GLYPH = '\x1b[7m \x1b[27m'; // inverse-video space

function mkStdio() {
  const stdout = new PassThrough(); stdout.columns = 80; stdout.rows = 24;
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.setEncoding = () => {};
  stdin.ref = () => {}; stdin.unref = () => {};
  return { stdin, stdout, stderr };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lastFrame(stdout) {
  let buf = '';
  stdout.on('data', (c) => { buf += c.toString('utf8'); });
  await sleep(80);
  return buf;
}

test('empty input box renders the caret glyph (cursor visible before typing)', async () => {
  const { stdin, stdout, stderr } = mkStdio();
  const instance = render(
    React.createElement(Editor, { history: [], onSubmit: async () => {} }),
    { stdout, stdin, stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  try {
    const frame = await lastFrame(stdout);
    assert.ok(frame.includes(GLYPH), 'inverse-video caret present with an empty buffer');
  } finally {
    try { instance.unmount(); } catch { /* teardown */ }
    try { instance.cleanup(); } catch { /* teardown */ }
  }
});

test('caret glyph follows typed text (sits after the buffer)', async () => {
  const { stdin, stdout, stderr } = mkStdio();
  const instance = render(
    React.createElement(Editor, { history: [], onSubmit: async () => {} }),
    { stdout, stdin, stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  try {
    stdin.write('hi');
    await sleep(60);
    const frame = await lastFrame(stdout);
    assert.ok(frame.includes(`hi${GLYPH}`), `caret rendered immediately after the text (frame tail: ${JSON.stringify(frame.slice(-200))})`);
  } finally {
    try { instance.unmount(); } catch { /* teardown */ }
    try { instance.cleanup(); } catch { /* teardown */ }
  }
});

test('caret glyph hidden while a modal picker owns the keyboard', async () => {
  const { stdin, stdout, stderr } = mkStdio();
  const instance = render(
    React.createElement(Editor, { history: [], onSubmit: async () => {}, modalOpen: true }),
    { stdout, stdin, stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  try {
    const frame = await lastFrame(stdout);
    assert.ok(!frame.includes(GLYPH), 'no caret while a modal is up');
  } finally {
    try { instance.unmount(); } catch { /* teardown */ }
    try { instance.cleanup(); } catch { /* teardown */ }
  }
});
