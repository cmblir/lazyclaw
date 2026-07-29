// tests/f-motion-helpers.test.mjs — the pure half of the motion package.
// Every animated component derives its frame from these, so they are the
// only thing that needs testing without a terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPINNER_FRAMES, SPINNER_MS, spinnerFrame, motionEnabled,
  formatElapsed, tween, revealRows, shimmerIndex,
} from '../tui/motion.mjs';

test('spinnerFrame cycles through the frames and wraps', () => {
  assert.equal(SPINNER_FRAMES.length, 10);
  assert.equal(spinnerFrame(0), SPINNER_FRAMES[0]);
  assert.equal(spinnerFrame(3), SPINNER_FRAMES[3]);
  assert.equal(spinnerFrame(10), SPINNER_FRAMES[0]);
  assert.equal(spinnerFrame(23), SPINNER_FRAMES[3]);
  assert.equal(spinnerFrame(-1), SPINNER_FRAMES[0], 'negative ticks must not throw or return undefined');
  assert.ok(SPINNER_MS > 0);
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

test('tween interpolates linearly and clamps progress', () => {
  assert.equal(tween(0, 10, 0), 0);
  assert.equal(tween(0, 10, 0.5), 5);
  assert.equal(tween(0, 10, 1), 10);
  assert.equal(tween(0, 10, -3), 0, 'progress below 0 clamps to `from`');
  assert.equal(tween(0, 10, 4), 10, 'progress above 1 clamps to `to`');
  assert.equal(tween(8, 2, 0.5), 5, 'tweens downward too');
});

test('revealRows walks 0 → totalRows over the duration', () => {
  assert.equal(revealRows(0, 20, 400), 0);
  assert.equal(revealRows(200, 20, 400), 10);
  assert.equal(revealRows(400, 20, 400), 20);
  assert.equal(revealRows(9999, 20, 400), 20, 'never exceeds totalRows');
  assert.equal(revealRows(100, 0, 400), 0);
  assert.equal(revealRows(100, 20, 0), 20, 'a zero duration reveals everything at once');
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
