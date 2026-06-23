import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { classifyKey, promptWithBack } from '../tui/prompt_back.mjs';

test('classifyKey: bare Esc → back; arrow/nav sequences → escseq (ignored)', () => {
  assert.equal(classifyKey('\x1b').type, 'back');
  assert.equal(classifyKey('\x1b[A').type, 'escseq');   // up arrow
  assert.equal(classifyKey('\x1b[D').type, 'escseq');   // left arrow
  assert.equal(classifyKey('\x1bOP').type, 'escseq');   // F1-style
});

test('classifyKey: enter → submit, Ctrl-C → cancel, backspace, printable text', () => {
  assert.equal(classifyKey('\r').type, 'submit');
  assert.equal(classifyKey('\n').type, 'submit');
  assert.equal(classifyKey('\x03').type, 'cancel');
  assert.equal(classifyKey('\x7f').type, 'backspace');
  assert.deepEqual(classifyKey('hi'), { type: 'text', text: 'hi' });
  assert.equal(classifyKey('').type, 'ignore');
});

// A fake raw-mode TTY stdin we can drive byte-by-byte.
function fakeTTY() {
  const s = new EventEmitter();
  s.isTTY = true;
  s.setRawMode = () => s;
  s.resume = () => s;
  s.pause = () => s;
  s.feed = (str) => s.emit('data', Buffer.from(str, 'utf8'));
  return s;
}
const sink = () => ({ buf: '', write(x) { this.buf += x; } });

test('promptWithBack: typing + Enter resolves the trimmed value, back=false', async () => {
  const input = fakeTTY(); const output = sink();
  const p = promptWithBack('name: ', { input, output });
  input.feed('be'); input.feed('n  '); input.feed('\r');
  assert.deepEqual(await p, { value: 'ben', back: false });
});

test('promptWithBack: bare Esc resolves back=true', async () => {
  const input = fakeTTY(); const output = sink();
  const p = promptWithBack('name: ', { input, output, escDelayMs: 5 });
  input.feed('\x1b');
  assert.deepEqual(await p, { value: '', back: true });
});

test('promptWithBack: an arrow key (Esc-sequence) does NOT trigger back', async () => {
  const input = fakeTTY(); const output = sink();
  const p = promptWithBack('name: ', { input, output, escDelayMs: 5 });
  input.feed('\x1b[A');     // up arrow — must be ignored, not back
  input.feed('ok'); input.feed('\r');
  assert.deepEqual(await p, { value: 'ok', back: false });
});

test('promptWithBack: backspace deletes the last char', async () => {
  const input = fakeTTY(); const output = sink();
  const p = promptWithBack('name: ', { input, output });
  input.feed('abc'); input.feed('\x7f'); input.feed('\r');
  assert.deepEqual(await p, { value: 'ab', back: false });
});
