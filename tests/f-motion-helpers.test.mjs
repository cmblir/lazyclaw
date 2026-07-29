// tests/f-motion-helpers.test.mjs — the pure half of the motion package.
// Every animated component derives its frame from these, so they are the
// only thing that needs testing without a terminal.
//
// Also covers useMotion at the hook level (interval lifecycle), via a real
// Ink mount (ink-testing-library) + real timers — this repo's existing
// convention (see f-new-clear.test.mjs) for testing effects that own timers,
// rather than fake timers whose interaction with React's own scheduler is
// less predictable.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import {
  SPINNER_FRAMES, SPINNER_MS, spinnerFrame, motionEnabled,
  formatElapsed, tween, revealRows, shimmerIndex, useMotion,
} from '../tui/motion.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('spinnerFrame cycles through the frames and wraps', () => {
  assert.equal(SPINNER_FRAMES.length, 10);
  assert.equal(spinnerFrame(0), SPINNER_FRAMES[0]);
  assert.equal(spinnerFrame(3), SPINNER_FRAMES[3]);
  assert.equal(spinnerFrame(10), SPINNER_FRAMES[0]);
  assert.equal(spinnerFrame(23), SPINNER_FRAMES[3]);
  assert.equal(spinnerFrame(-1), SPINNER_FRAMES[0], 'negative ticks must not throw or return undefined');
  assert.ok(SPINNER_MS > 0);
});

test('spinnerFrame never returns undefined for non-finite or non-numeric ticks', () => {
  assert.equal(spinnerFrame(NaN), SPINNER_FRAMES[0]);
  assert.equal(spinnerFrame(Infinity), SPINNER_FRAMES[0]);
  assert.equal(spinnerFrame(-Infinity), SPINNER_FRAMES[0]);
  assert.equal(spinnerFrame(undefined), SPINNER_FRAMES[0]);
  assert.equal(spinnerFrame('abc'), SPINNER_FRAMES[0]);
});

test('motionEnabled is off without a TTY, with NO_COLOR, on dumb terminals, and on opt-out', () => {
  const tty = { isTTY: true };
  assert.equal(motionEnabled({}, tty), true);
  assert.equal(motionEnabled({ LAZYCLAW_NO_MOTION: '1' }, tty), false);
  assert.equal(motionEnabled({ NO_COLOR: '1' }, tty), false);
  assert.equal(motionEnabled({ TERM: 'dumb' }, tty), false);
  assert.equal(motionEnabled({}, { isTTY: false }), false);
  assert.equal(motionEnabled({}, null), false);
});

test('formatElapsed renders seconds under a minute and m/s above', () => {
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(999), '0s');
  assert.equal(formatElapsed(7400), '7s');
  assert.equal(formatElapsed(59_999), '59s');
  assert.equal(formatElapsed(60_000), '1m00s');
  assert.equal(formatElapsed(64_000), '1m04s');
  assert.equal(formatElapsed(3_725_000), '62m05s');
  assert.equal(formatElapsed(-5), '0s');
});

test('formatElapsed never leaks a non-finite value into the formatted string', () => {
  assert.equal(formatElapsed(Infinity), '0s');
  assert.equal(formatElapsed(NaN), '0s');
  assert.equal(formatElapsed(undefined), '0s');
});

test('tween interpolates linearly and clamps progress', () => {
  assert.equal(tween(0, 10, 0), 0);
  assert.equal(tween(0, 10, 0.5), 5);
  assert.equal(tween(0, 10, 1), 10);
  assert.equal(tween(0, 10, -3), 0, 'progress below 0 clamps to `from`');
  assert.equal(tween(0, 10, 4), 10, 'progress above 1 clamps to `to`');
  assert.equal(tween(8, 2, 0.5), 5, 'tweens downward too');
});

test('tween always returns a number, even with non-numeric from/to', () => {
  assert.equal(typeof tween('5', 10, 0.5), 'number', 'a numeric string must not trigger + concatenation');
  assert.equal(typeof tween('abc', 10, 0.5), 'number', 'a non-numeric string must not produce e.g. "abcNaN"');
  assert.equal(typeof tween(0, 'abc', 0.5), 'number');
  assert.ok(Number.isFinite(tween('abc', 'xyz', 0.5)), 'unusable from/to falls back to a finite number, not NaN');
});

test('revealRows walks 0 → totalRows over the duration', () => {
  assert.equal(revealRows(0, 20, 400), 0);
  assert.equal(revealRows(200, 20, 400), 10);
  assert.equal(revealRows(400, 20, 400), 20);
  assert.equal(revealRows(9999, 20, 400), 20, 'never exceeds totalRows');
  assert.equal(revealRows(100, 0, 400), 0);
  assert.equal(revealRows(100, 20, 0), 20, 'a zero duration reveals everything at once');
});

test('revealRows never propagates NaN from a non-finite elapsedMs', () => {
  assert.equal(revealRows(NaN, 20, 400), 0);
  assert.ok(Number.isFinite(revealRows(Infinity, 20, 400)));
});

test('shimmerIndex sweeps the palette per row without going out of bounds', () => {
  for (let tick = 0; tick < 40; tick++) {
    for (let row = 0; row < 13; row++) {
      const i = shimmerIndex(row, tick, 4);
      assert.ok(Number.isInteger(i) && i >= 0 && i < 4, `out of range: ${i}`);
    }
  }
  // Advancing the tick must actually move the sweep.
  const before = Array.from({ length: 13 }, (_, r) => shimmerIndex(r, 0, 4));
  const after = Array.from({ length: 13 }, (_, r) => shimmerIndex(r, 1, 4));
  assert.notDeepEqual(before, after);
});

test('shimmerIndex never propagates NaN from non-finite inputs', () => {
  assert.equal(shimmerIndex(NaN, 0, 4), 0);
  assert.ok(Number.isInteger(shimmerIndex(0, NaN, 4)));
  assert.ok(Number.isInteger(shimmerIndex(0, 0, NaN)));
});

// ─── useMotion hook-level interval lifecycle ───────────────────────────────
//
// The pure functions above are what every component derives its frame from;
// useMotion is the one piece of this module that touches a real timer, so it
// needs its own coverage — a leaked interval in a TUI keeps the process alive
// and repaints forever. Spies on global.setInterval/clearInterval (rather
// than node:test's mock timers) so the assertions observe the *real* interval
// lifecycle while React's effects run on the real scheduler, avoiding any
// fake-timer/scheduler interaction pitfalls.

function withIntervalSpy(fn) {
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  const calls = { created: 0, cleared: 0 };
  global.setInterval = (...args) => { calls.created += 1; return realSetInterval(...args); };
  global.clearInterval = (id) => { calls.cleared += 1; return realClearInterval(id); };
  return (async () => {
    try {
      return await fn(calls);
    } finally {
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
    }
  })();
}

function Probe({ active, intervalMs }) {
  const tick = useMotion(active, intervalMs);
  return React.createElement(Text, null, String(tick));
}

// React only runs useEffect cleanup/setup (a "passive effect") on a later
// scheduler tick, never synchronously inside rerender()/unmount() — confirmed
// empirically (clearInterval fires one setImmediate after unmount(), not
// before). Tests must await this tick before asserting on interval counts.
const flushEffects = () => new Promise((resolve) => setImmediate(resolve));

test('useMotion owns exactly one interval while active', async () => {
  await withIntervalSpy(async (calls) => {
    const { lastFrame, unmount } = render(React.createElement(Probe, { active: true, intervalMs: 10 }));
    try {
      await sleep(45);
      assert.equal(calls.created, 1, 'exactly one setInterval while active');
      assert.equal(calls.cleared, 0, 'not cleared while still active and mounted');
      assert.ok(Number(lastFrame()) > 0, `tick should have advanced, got ${lastFrame()}`);
    } finally {
      // Always unmount, even on assertion failure — an uncleared real
      // interval here would outlive the test and hang the whole suite.
      unmount();
      await flushEffects();
    }
  });
});

test('useMotion tears down its interval when active flips to false', async () => {
  await withIntervalSpy(async (calls) => {
    const { rerender, lastFrame, unmount } = render(React.createElement(Probe, { active: true, intervalMs: 10 }));
    try {
      await sleep(35);
      assert.ok(Number(lastFrame()) > 0, 'sanity: ticking while active');
      rerender(React.createElement(Probe, { active: false, intervalMs: 10 }));
      await flushEffects();
      await sleep(10);
      assert.equal(calls.created, 1, 'no new interval is created after going inactive');
      assert.equal(calls.cleared, 1, 'the interval is cleared the moment active goes false');
      assert.equal(lastFrame(), '0', 'tick resets to 0 while inactive');
    } finally {
      unmount();
      await flushEffects();
    }
  });
});

test('useMotion tears down its interval on unmount', async () => {
  await withIntervalSpy(async (calls) => {
    const { unmount } = render(React.createElement(Probe, { active: true, intervalMs: 10 }));
    await sleep(20);
    unmount();
    await flushEffects();
    assert.equal(calls.created, 1);
    assert.equal(calls.cleared, 1, 'the interval must be cleared on unmount');
  });
});

test('useMotion swaps the interval when intervalMs changes without resetting the tick', async () => {
  await withIntervalSpy(async (calls) => {
    const { rerender, lastFrame, unmount } = render(React.createElement(Probe, { active: true, intervalMs: 10 }));
    try {
      await sleep(45);
      const before = Number(lastFrame());
      assert.ok(before > 0, 'tick should have advanced before the interval swap');
      rerender(React.createElement(Probe, { active: true, intervalMs: 20 }));
      await flushEffects();
      await sleep(5);
      assert.equal(calls.created, 2, 'a new interval is created for the new intervalMs');
      assert.equal(calls.cleared, 1, 'the old interval is cleared before the new one starts');
      assert.ok(Number(lastFrame()) >= before, 'the tick keeps counting up — the swap does not reset it');
    } finally {
      unmount();
      await flushEffects();
    }
  });
});
