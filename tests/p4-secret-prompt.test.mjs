// tests/p4-secret-prompt.test.mjs — _quickPromptSecret reads a value in raw
// mode and echoes bullets, never the real characters (so api keys / channel
// tokens don't leak to the terminal / scrollback). Security regression guard.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { _quickPromptSecret } from '../tui/pickers.mjs';

// Fake TTY stdin/stdout: stdin emits typed bytes; stdout records everything written.
function withFakeTTY(typed) {
  const origIn = process.stdin, origOut = process.stdout;
  const out = [];
  const stdin = new EventEmitter();
  stdin.isTTY = true; stdin.isRaw = false;
  stdin.setRawMode = (v) => { stdin.isRaw = v; };
  stdin.resume = () => {}; stdin.ref = () => {};
  stdin.setEncoding = () => {}; stdin.readableEncoding = 'utf8';
  const stdout = { write: (s) => { out.push(String(s)); return true; } };
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
  // Feed the typed bytes on next tick so the listener is attached first.
  setImmediate(() => { for (const ch of typed) stdin.emit('data', ch); });
  const restore = () => {
    Object.defineProperty(process, 'stdin', { value: origIn, configurable: true });
    Object.defineProperty(process, 'stdout', { value: origOut, configurable: true });
  };
  return { out, restore, stdin };
}

test('_quickPromptSecret returns the typed value but echoes only bullets', async () => {
  const { out, restore } = withFakeTTY('xoxb-secret\r');
  try {
    const v = await _quickPromptSecret('token: ');
    assert.equal(v, 'xoxb-secret');
    const screen = out.join('');
    assert.ok(!screen.includes('xoxb-secret'), 'the real token must never be written to stdout');
    assert.ok(screen.includes('•'), 'bullets are echoed');
    // one bullet per character of the secret (11 chars)
    assert.equal((screen.match(/•/g) || []).length, 'xoxb-secret'.length);
  } finally { restore(); }
});

test('_quickPromptSecret handles backspace', async () => {
  const { restore } = withFakeTTY('abX\x7fc\r'); // a b X <BS> c → "abc"
  try {
    assert.equal(await _quickPromptSecret('k: '), 'abc');
  } finally { restore(); }
});

test('_quickPromptSecret Ctrl-C aborts to empty string', async () => {
  const { restore } = withFakeTTY('abc\x03'); // Ctrl-C
  try {
    assert.equal(await _quickPromptSecret('k: '), '');
  } finally { restore(); }
});

test('_quickPromptSecret restores raw mode to its prior state', async () => {
  const { restore, stdin } = withFakeTTY('k\r');
  try {
    await _quickPromptSecret('k: ');
    assert.equal(stdin.isRaw, false, 'raw mode restored to false');
  } finally { restore(); }
});
