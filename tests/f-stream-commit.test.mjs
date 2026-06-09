// tests/f-stream-commit.test.mjs — onStreamChunk commits completed lines to the
// <Static> scrollback as they stream, keeping only the trailing partial in the
// live region. This keeps the live frame short so a reply taller than the
// terminal scrolls up ABOVE the sticky editor instead of spilling below it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeReplState, onUserInput, onStreamChunk, onTurnComplete } from '../tui/repl.mjs';

test('newline-free chunks still just accumulate (back-compat)', () => {
  let s = makeReplState();
  s = onStreamChunk(s, { chunk: 'Hi ' });
  s = onStreamChunk(s, { chunk: 'there!' });
  assert.equal(s.liveAssistant, 'Hi there!');
  assert.equal(s.scrollback.length, 0, 'nothing committed without a newline');
});

test('completed lines commit to scrollback; trailing partial stays live', () => {
  let s = makeReplState();
  s = onUserInput(s, { text: 'q', controller: null });
  const before = s.scrollback.length;
  s = onStreamChunk(s, { chunk: 'line1\nline2\npart' });
  assert.equal(s.scrollback.length, before + 1, 'completed lines committed as one item');
  const last = s.scrollback[s.scrollback.length - 1];
  assert.equal(last.kind, 'assistant');
  assert.equal(last.text, 'line1\nline2');
  assert.equal(s.liveAssistant, 'part', 'trailing partial stays in the live region');
});

test('a trailing newline flushes the remaining partial', () => {
  let s = makeReplState();
  s = onStreamChunk(s, { chunk: 'partial' });
  assert.equal(s.liveAssistant, 'partial');
  s = onStreamChunk(s, { chunk: '-done\n' });
  assert.equal(s.scrollback[s.scrollback.length - 1].text, 'partial-done');
  assert.equal(s.liveAssistant, '', 'live region empty after the newline flush');
});

test('end-to-end: a multi-line reply ends with an empty live region, no double-commit', () => {
  let s = makeReplState();
  s = onUserInput(s, { text: 'q', controller: null });
  // run_turn streams the body then a trailing newline.
  s = onStreamChunk(s, { chunk: 'a\nb\nc' });
  s = onStreamChunk(s, { chunk: '\n' });           // run_turn's trailing '\n'
  assert.equal(s.liveAssistant, '');
  const beforeComplete = s.scrollback.length;
  s = onTurnComplete(s, { reason: 'done' });
  // liveAssistant was empty → no extra empty assistant item appended.
  assert.equal(s.scrollback.length, beforeComplete, 'no double-commit on turn complete');
});
