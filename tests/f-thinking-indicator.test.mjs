// tests/f-thinking-indicator.test.mjs — the gap between "message sent" and
// "first token" had no feedback. <Thinking/> fills it.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { Thinking, thinkingLabel } from '../tui/thinking.mjs';
import { SPINNER_FRAMES } from '../tui/motion.mjs';

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
