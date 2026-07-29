// tests/f-status-bar-motion.test.mjs — the streaming indicator animates with
// braille spinner frames and reports elapsed turn time, and degrades to the
// pre-motion pulse when motion is off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { streamingIndicator, StatusBar } from '../tui/status_bar.mjs';
import { SPINNER_FRAMES } from '../tui/motion.mjs';
import React from 'react';
import { render } from 'ink-testing-library';

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

// The HUD's live rate segment (tui/hud.mjs formatRate) is fed from a
// `liveChars` prop only while an in-flight turn is actually streaming — a
// finished/idle turn has no meaningful "chars this turn" sample to show.
const hud = { inTok: 100, outTok: 50, costUsd: 0, trainer: '', orch: '' };

test('mounted StatusBar shows the live rate segment while streaming with hud + liveChars', () => {
  const { lastFrame, unmount } = render(React.createElement(StatusBar, {
    provider: 'anthropic', model: 'opus', streaming: true,
    ctxUsed: 100, ctxTotal: 1000, streamStartedAt: Date.now() - 2000,
    hud, liveChars: 5000,
  }));
  try {
    // Not pinning the exact digits: elapsedMs is `Date.now() - streamStartedAt`
    // computed at render time, so it drifts by however long the test took to
    // reach this assertion. Assert the shape instead (no "k" — ~2500 ch/s stays
    // well under the 10k ch/s abbreviation threshold regardless of that drift).
    const frame = plain(lastFrame() || '');
    assert.match(frame, /⇅ \d+ ch\/s/, `expected a rate segment, got: ${frame}`);
    assert.doesNotMatch(frame, /k ch\/s/, `expected no k-abbreviation at ~2.5k ch/s, got: ${frame}`);
  } finally {
    unmount();
  }
});

test('mounted StatusBar hides the rate segment once the turn ends', () => {
  const { lastFrame, unmount } = render(React.createElement(StatusBar, {
    provider: 'anthropic', model: 'opus', streaming: false,
    ctxUsed: 100, ctxTotal: 1000, streamStartedAt: null,
    hud, liveChars: 5000,
  }));
  try {
    const frame = plain(lastFrame() || '');
    assert.doesNotMatch(frame, /⇅/, `rate segment must not linger after the turn ends, got: ${frame}`);
  } finally {
    unmount();
  }
});
