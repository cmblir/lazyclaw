// tests/f-thinking-indicator.test.mjs — the gap between "message sent" and
// "first token" had no feedback. <Thinking/> fills it.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { Thinking, thinkingLabel } from '../tui/thinking.mjs';
import { SPINNER_FRAMES, motionEnabled } from '../tui/motion.mjs';
import { makeReplState, onUserInput, onStreamChunk } from '../tui/repl_reducers.mjs';

test('thinkingLabel pairs the spinner frame with the word', () => {
  assert.equal(thinkingLabel(0), `${SPINNER_FRAMES[0]} thinking…`);
  assert.equal(thinkingLabel(4), `${SPINNER_FRAMES[4]} thinking…`);
});

test('Thinking is a component that accepts an active flag', () => {
  const el = React.createElement(Thinking, { active: true });
  assert.equal(el.type, Thinking);
  assert.equal(el.props.active, true);
});

test('Thinking renders nothing when inactive', () => {
  // The component short-circuits before any hook that needs a renderer.
  assert.equal(Thinking({ active: false }), null);
});

test('under node --test, motionEnabled() is false, so Thinking({active: true}) already returns null with no mounting', () => {
  // Pins the motion-off half of the `||` short-circuit: stdout is not a TTY
  // under the test runner, so this never reaches useMotion even when active
  // is true. If this ever starts returning a non-null element, either the
  // gate broke or the test runner's stdout became a TTY — both worth knowing.
  assert.equal(motionEnabled(), false);
  assert.equal(Thinking({ active: true }), null);
});

test('regression guard: walking the real reducer chain, the activation expression is false right after a line-terminated chunk', () => {
  // Mirrors the bug exactly: submit a turn, receive a chunk that ends on a
  // newline (flushed to scrollback, liveAssistant emptied), then compute the
  // Thinking activation condition the same way tui/repl.mjs does. Before the
  // fix this read `state.streaming && !state.liveAssistant`, which is true
  // here (liveAssistant is '') — that reactivated the spinner under content
  // already visible in scrollback. The reducers must keep this false.
  let s = makeReplState();
  s = onUserInput(s, { text: 'hi', controller: { abort: () => {} } });
  s = onStreamChunk(s, { chunk: 'first line\n' });
  assert.equal(s.liveAssistant, '', 'sanity check: the newline flush really does empty liveAssistant');
  assert.deepEqual(s.scrollback.map((it) => it.kind), ['user', 'assistant'],
    'sanity check: the completed line already landed in scrollback');

  const active = s.streaming && !s.hasStreamedContent;
  assert.equal(active, false, 'the thinking indicator must not reactivate once content has streamed');
});
