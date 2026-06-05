import test from 'node:test';
import assert from 'node:assert/strict';
import { makeReplState, onUserInput, onEscape, onTurnComplete } from '../tui/repl.mjs';

test('input during streaming aborts current turn and queues prepend', async () => {
  let aborted = false;
  const ctrl = { abort: () => { aborted = true; } };
  let s = makeReplState();
  s = onUserInput(s, { text: 'first task', controller: ctrl });
  assert.equal(s.streaming, true);
  s = onUserInput(s, { text: 'oh wait, do this instead', controller: ctrl });
  assert.equal(aborted, true);
  assert.equal(s.pendingPrepend, 'oh wait, do this instead');
  s = onTurnComplete(s, { reason: 'aborted' });
  assert.equal(s.streaming, false);
  assert.equal(s.nextTurnFirstMessage, 'oh wait, do this instead');
  assert.equal(s.pendingPrepend, null);
});

test('Esc during stream aborts cleanly without queuing prepend', () => {
  let aborted = false;
  const ctrl = { abort: () => { aborted = true; } };
  let s = makeReplState();
  s = onUserInput(s, { text: 'first', controller: ctrl });
  s = onEscape(s);
  assert.equal(aborted, true);
  assert.equal(s.pendingPrepend, null);
});

test('input while idle is treated as a normal new turn', () => {
  let s = makeReplState();
  s = onUserInput(s, { text: 'hello', controller: { abort: () => {} } });
  assert.equal(s.streaming, true);
  assert.equal(s.pendingPrepend, null);
});
