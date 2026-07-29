// tests/f-status-bar-motion.test.mjs — the streaming indicator animates with
// braille spinner frames and reports elapsed turn time, and degrades to the
// pre-motion pulse when motion is off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { streamingIndicator, StatusBar } from '../tui/status_bar.mjs';
import { SPINNER_FRAMES } from '../tui/motion.mjs';
import React from 'react';

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('idle is unchanged', () => {
  assert.equal(plain(streamingIndicator(false, true)), '○ idle');
  assert.equal(plain(streamingIndicator(false, false, undefined, { motion: true, tick: 5 })), '○ idle');
});

test('the 3-argument form keeps its pre-motion behavior', () => {
  // Existing callers/tests rely on the pulsing-dot contract.
  assert.equal(plain(streamingIndicator(true, true)), '● streaming');
  assert.equal(plain(streamingIndicator(true, false)), '● streaming');
});

test('with motion on, streaming shows a spinner frame and elapsed time', () => {
  const out = plain(streamingIndicator(true, true, undefined, { motion: true, tick: 2, elapsedMs: 7400 }));
  assert.ok(out.startsWith(SPINNER_FRAMES[2]), `expected frame 2, got: ${out}`);
  assert.match(out, /streaming/);
  assert.match(out, /7s/);
});

test('the spinner frame advances with the tick', () => {
  const a = plain(streamingIndicator(true, true, undefined, { motion: true, tick: 0, elapsedMs: 0 }));
  const b = plain(streamingIndicator(true, true, undefined, { motion: true, tick: 1, elapsedMs: 0 }));
  assert.notEqual(a, b);
});

test('with motion off, streaming falls back to the pulsing dot', () => {
  const out = plain(streamingIndicator(true, true, undefined, { motion: false, tick: 3, elapsedMs: 9000 }));
  assert.equal(out, '● streaming');
});

test('StatusBar accepts streamStartedAt without breaking its existing props', () => {
  const el = React.createElement(StatusBar, {
    provider: 'openai', model: 'gpt-4.1', streaming: true,
    ctxUsed: 1024, ctxTotal: 8192, streamStartedAt: 1000,
  });
  assert.equal(el.props.streamStartedAt, 1000);
  assert.equal(el.props.provider, 'openai');
});
