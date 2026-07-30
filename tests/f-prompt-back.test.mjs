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

// Regression: promptWithBack must RE-REFERENCE stdin, not just resume it.
//
// tui/pickers.mjs's _arrowMenu unrefs process.stdin in its cleanup so that
// `lazyclaw setup` can exit instead of hanging. libuv's unref is sticky:
// neither resume() nor attaching a 'data' listener re-references the handle.
// So a backPrompt running straight after an arrow menu — which is exactly the
// setup wizard's context-window step followed by the permission step — attached
// its listener to an unreferenced handle, the event loop drained, and node
// exited 0 with the prompt label on screen and the answer never read.
//
// _quickPrompt (pickers.mjs) already pairs resume() with ref() for this very
// reason. This test exists because the fakeTTY above has no `ref`, which is why
// the four tests below never caught the omission.
test('promptWithBack: re-references stdin after an _arrowMenu cleanup unref\'d it', async () => {
  const input = fakeTTY(); const output = sink();
  let refs = 0;
  input.ref = () => { refs += 1; return input; };
  const p = promptWithBack('name: ', { input, output });
  input.feed('x');
  input.feed('\r');
  await p;
  assert.equal(refs, 1, 'resume() alone leaves the handle unreferenced — the loop drains and setup exits mid-prompt');
});

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
