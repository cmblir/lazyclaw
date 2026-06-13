// tests/f-key-echo-mask.test.mjs — SECURITY/UX: when the modal picker drives a
// SECRET field (the /provider key-entry flow), the typed value lives in the
// host-owned filter buffer (`query`) and was echoed verbatim in the filter row,
// exposing api keys to shoulder-surfing / scrollback / screen-share.
//
// Contract: ModalPicker, given `secret: true`, must render the query MASKED
// (one bullet per visible character) instead of the raw characters. It must NOT
// mask a normal (non-secret) text input, and it must mask per *visible* glyph so
// CJK width stays correct. ModalPicker is purely presentational — it never
// mutates the buffer, so the real value the host submits is untouched.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { PassThrough } from 'node:stream';
import { render } from 'ink';

import { ModalPicker } from '../tui/modal_picker.mjs';

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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function renderFrame(props) {
  const { stdin, stdout, stderr, frames } = mkStdio();
  const instance = render(
    React.createElement(ModalPicker, props),
    { stdout, stdin, stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  await wait(60);
  const out = frames();
  try { instance.unmount(); } catch { /* teardown */ }
  try { instance.cleanup(); } catch { /* teardown */ }
  return out;
}

const SECRET = 'sk-ant-secret123';
const baseProps = {
  title: 'anthropic needs an api key',
  items: [{ id: '__text__', label: '✓ use what I typed above' }],
  selectedIndex: 0,
  searchable: true,
  columns: 80,
};

test('a SECRET field does NOT echo the typed key in the rendered frame', async () => {
  const frame = await renderFrame({ ...baseProps, query: SECRET, secret: true });
  assert.ok(!frame.includes(SECRET),
    `plaintext key must not appear in the frame (tail: ${JSON.stringify(frame.slice(-200))})`);
  // The buffer is still represented — one bullet per typed character.
  assert.ok(frame.includes('•'.repeat(SECRET.length)),
    'masked bullets stand in for the typed characters');
});

test('a non-secret text field still echoes the query normally', async () => {
  const frame = await renderFrame({ ...baseProps, query: 'gpt-4o-mini', secret: false });
  assert.ok(frame.includes('gpt-4o-mini'), 'non-secret input is shown verbatim');
  assert.ok(!frame.includes('•'), 'no masking on a non-secret field');
});

test('masking is per visible character (CJK width preserved)', async () => {
  const cjk = '비밀키한글'; // 5 visible glyphs
  const frame = await renderFrame({ ...baseProps, query: cjk, secret: true });
  assert.ok(!frame.includes(cjk), 'CJK secret is not echoed');
  assert.ok(frame.includes('•'.repeat(5)), 'one bullet per visible CJK glyph');
});
