import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEditorState, applyKey } from '../tui/editor.mjs';

test('Enter on single-line buffer emits submit event', () => {
  let s = makeEditorState({ history: [] });
  s = applyKey(s, { input: 'hi', key: {} });
  s = applyKey(s, { input: '', key: { return: true } });
  assert.equal(s.lastSubmit, 'hi');
  assert.equal(s.buffer, '');
});

test('Shift+Enter inserts a literal newline, does not submit', () => {
  let s = makeEditorState({ history: [] });
  s = applyKey(s, { input: 'a', key: {} });
  s = applyKey(s, { input: '', key: { return: true, shift: true } });
  s = applyKey(s, { input: 'b', key: {} });
  assert.equal(s.buffer, 'a\nb');
  assert.equal(s.lastSubmit, null);
});

test('Up arrow walks history backwards', () => {
  let s = makeEditorState({ history: ['old1', 'old2'] });
  s = applyKey(s, { input: '', key: { upArrow: true } });
  assert.equal(s.buffer, 'old2');
  s = applyKey(s, { input: '', key: { upArrow: true } });
  assert.equal(s.buffer, 'old1');
});

test('paste of >= 16 chars is flagged as paste', () => {
  let s = makeEditorState({ history: [] });
  const big = 'x'.repeat(64);
  s = applyKey(s, { input: big, key: {}, paste: true });
  assert.equal(s.buffer, big);
  assert.equal(s.lastWasPaste, true);
});
