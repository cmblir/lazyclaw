// tests/p4-editor-arg-complete.test.mjs — Tab in argument position hands the
// buffer to the host (onArgComplete); a host-pushed argInject value is applied
// into the buffer via fillArgToken.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { Editor } from '../tui/editor.mjs';

function mkStdio() {
  const stdout = new PassThrough(); stdout.columns = 80; stdout.rows = 24;
  const stdin = new PassThrough();
  stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.setEncoding = () => {};
  stdin.ref = () => {}; stdin.unref = () => {};
  return { stdin, stdout, stderr: new PassThrough() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Tab in arg position calls onArgComplete with the buffer', async () => {
  const { stdin, stdout, stderr } = mkStdio();
  let seen = null;
  const inst = render(React.createElement(Editor, {
    history: [], onSubmit: () => {}, onBufferChange: () => {},
    argCompletable: true,
    onArgComplete: (buf) => { seen = buf; },
  }), { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false });
  try {
    stdin.write('/model gpt');
    await sleep(60);
    stdin.write('\t');
    for (let i = 0; i < 20 && seen === null; i++) await sleep(20);
    assert.equal(seen, '/model gpt');
  } finally { try { inst.unmount(); } catch {} try { inst.cleanup(); } catch {} }
});

test('Tab does nothing when not argCompletable', async () => {
  const { stdin, stdout, stderr } = mkStdio();
  let called = false;
  const inst = render(React.createElement(Editor, {
    history: [], onSubmit: () => {}, onBufferChange: () => {},
    argCompletable: false,
    onArgComplete: () => { called = true; },
  }), { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false });
  try {
    stdin.write('hello ');
    await sleep(40);
    stdin.write('\t');
    await sleep(60);
    assert.equal(called, false);
  } finally { try { inst.unmount(); } catch {} try { inst.cleanup(); } catch {} }
});
