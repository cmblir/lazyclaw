// tests/f-ctx-gauge-tween.test.mjs — the ctx gauge fills stepwise instead of
// jumping. formatGauge grows an optional cell override so the animation can
// drive the bar while the numbers stay truthful.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatGauge, gaugeCells } from '../tui/hud.mjs';
import { tween } from '../tui/motion.mjs';

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('gaugeCells maps a percentage onto the 8-cell bar', () => {
  assert.equal(gaugeCells(0), 0);
  assert.equal(gaugeCells(50), 4);
  assert.equal(gaugeCells(100), 8);
  assert.equal(gaugeCells(140), 8, 'never overflows the bar');
  assert.equal(gaugeCells(-5), 0);
});

test('formatGauge is unchanged without an override', () => {
  const out = plain(formatGauge(4096, 8192));
  assert.match(out, /50%/);
  assert.equal((out.match(/▰/g) || []).length, 4);
});

test('formatGauge honours a cell override while keeping the real numbers', () => {
  const out = plain(formatGauge(4096, 8192, 1));
  assert.match(out, /50%/, 'the percentage must stay truthful during the tween');
  assert.equal((out.match(/▰/g) || []).length, 1);
  assert.equal((out.match(/▱/g) || []).length, 7);
});

test('formatGauge still reports missing data as --', () => {
  assert.equal(formatGauge(null, 8192), '--');
  assert.equal(formatGauge(100, 0), '--');
});

test('tweening cells walks from the old fill to the new one', () => {
  const from = gaugeCells(20);   // 2
  const to = gaugeCells(80);     // 6
  assert.equal(Math.round(tween(from, to, 0)), 2);
  assert.equal(Math.round(tween(from, to, 0.5)), 4);
  assert.equal(Math.round(tween(from, to, 1)), 6);
});

// ─── Mounted StatusBar: gauge tween + the elapsed clock deferred from
// Task 8 ────────────────────────────────────────────────────────────────
//
// Task 8 added the streaming spinner and elapsed clock to StatusBar, but
// nothing ever mounted it with a real streamStartedAt, so the
// `Date.now() - streamStartedAt` wiring was pinned by no test. This task
// touches the same component to add the gauge tween, so both animations are
// covered here with one harness.
//
// motionEnabled() reads process.stdout.isTTY via its default parameter
// (`stream = process.stdout`) — the REAL global stream, not whatever fake
// stdout ink-testing-library hands the mounted instance — and it is falsy
// under `node --test`. Force the gate open for the duration of the mount and
// restore every value in a `finally`, mirroring the save/restore discipline
// in tests/helpers/repl_harness.mjs: a leaked patch here would corrupt every
// later test in this file (and in this process).
import { render } from 'ink-testing-library';
import React from 'react';
import { StatusBar } from '../tui/status_bar.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withMotionForced(fn) {
  const saved = {
    isTTY: process.stdout.isTTY,
    noColor: process.env.NO_COLOR,
    term: process.env.TERM,
    noMotion: process.env.LAZYCLAW_NO_MOTION,
  };
  try {
    process.stdout.isTTY = true;
    delete process.env.NO_COLOR;
    process.env.TERM = 'xterm-256color';
    delete process.env.LAZYCLAW_NO_MOTION;
    return await fn();
  } finally {
    process.stdout.isTTY = saved.isTTY;
    if (saved.noColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved.noColor;
    if (saved.term === undefined) delete process.env.TERM; else process.env.TERM = saved.term;
    if (saved.noMotion === undefined) delete process.env.LAZYCLAW_NO_MOTION; else process.env.LAZYCLAW_NO_MOTION = saved.noMotion;
  }
}

test('mounted StatusBar renders the streaming elapsed clock (motion forced on)', async () => {
  await withMotionForced(async () => {
    const streamStartedAt = Date.now() - 7400;
    const { lastFrame, unmount } = render(React.createElement(StatusBar, {
      provider: 'anthropic', model: 'opus', streaming: true,
      ctxUsed: 100, ctxTotal: 1000, streamStartedAt,
    }));
    try {
      await sleep(20);
      const frame = plain(lastFrame() || '');
      assert.match(frame, /7s/, `expected the elapsed clock to show 7s, got: ${frame}`);
    } finally {
      unmount();
    }
  });
});

test('mounted StatusBar tweens the ctx gauge stepwise and lands on the true value', async () => {
  await withMotionForced(async () => {
    // 20% of 1000 -> gaugeCells(20) = 2 filled cells.
    const { rerender, lastFrame, unmount } = render(React.createElement(StatusBar, {
      provider: 'anthropic', model: 'opus', streaming: false,
      ctxUsed: 200, ctxTotal: 1000,
    }));
    try {
      await sleep(20);
      const initial = plain(lastFrame() || '');
      assert.equal((initial.match(/▰/g) || []).length, 2,
        `expected 2 filled cells on first mount, got: ${initial}`);

      // Turn ends: ctx jumps to 75% -> gaugeCells(75) = 6 filled cells.
      rerender(React.createElement(StatusBar, {
        provider: 'anthropic', model: 'opus', streaming: false,
        ctxUsed: 750, ctxTotal: 1000,
      }));
      await sleep(120); // partway through the 300ms tween

      const mid = plain(lastFrame() || '');
      assert.match(mid, /75%/, 'the percentage must stay truthful mid-tween');
      const midFilled = (mid.match(/▰/g) || []).length;
      assert.ok(midFilled > 2 && midFilled < 6,
        `expected a partial fill strictly between 2 and 6, got ${midFilled} (${mid})`);

      await sleep(500); // well past GAUGE_TWEEN_MS — the tween must have settled
      const settled = plain(lastFrame() || '');
      assert.match(settled, /75%/);
      assert.equal((settled.match(/▰/g) || []).length, 6,
        `expected the fully-settled 6 cells, got: ${settled}`);
      assert.equal((settled.match(/▱/g) || []).length, 2);
    } finally {
      unmount();
    }
  });
});
