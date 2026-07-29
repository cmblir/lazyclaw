// tests/f-error-flash.test.mjs — a failed turn pulses the input border red so
// the failure is visible even if the error text scrolled past.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import chalk from 'chalk';
import { render } from 'ink-testing-library';
import { flashBorderColor, FLASH_MS } from '../tui/editor.mjs';
import { theme } from '../tui/theme.mjs';
import { makeReplState, onUserInput, onTurnComplete } from '../tui/repl_reducers.mjs';
import { ReplApp } from '../tui/repl.mjs';
import { withMotionForced } from './helpers/motion_gate.mjs';

test('no error means the normal border', () => {
  assert.equal(flashBorderColor(null, 1000, true), theme.border);
});

test('motion off means the normal border even right after an error', () => {
  assert.equal(flashBorderColor(1000, 1000, false), theme.border);
});

test('the border is red inside the flash window and normal after it', () => {
  const at = 1000;
  assert.notEqual(flashBorderColor(at, at, true), theme.border);
  assert.notEqual(flashBorderColor(at, at + FLASH_MS - 1, true), theme.border);
  assert.equal(flashBorderColor(at, at + FLASH_MS, true), theme.border);
  assert.equal(flashBorderColor(at, at + FLASH_MS + 5000, true), theme.border);
});

test('the flash pulses rather than staying solid', () => {
  const at = 0;
  const samples = [];
  for (let t = 0; t < FLASH_MS; t += FLASH_MS / 8) samples.push(flashBorderColor(at, t, true));
  assert.ok(new Set(samples).size > 1, 'expected the colour to alternate during the flash');
});

test('onTurnComplete records the error timestamp and clears it on success', () => {
  const ctrl = { abort: () => {} };
  assert.equal(makeReplState().lastErrorAt, null);

  let s = onUserInput(makeReplState(), { text: 'x', controller: ctrl });
  s = onTurnComplete(s, { reason: 'error', error: 'boom' });
  assert.ok(typeof s.lastErrorAt === 'number' && s.lastErrorAt > 0);

  let ok = onUserInput(s, { text: 'y', controller: ctrl });
  ok = onTurnComplete(ok, { reason: 'done' });
  assert.equal(ok.lastErrorAt, null, 'a successful turn clears the flash');
});

// ─── Mounted wiring guard ───────────────────────────────────────────────
//
// The plan has been bitten twice already by a correct component sitting
// behind an unpinned wiring line in tui/repl.mjs (a condition, then a prop
// name). This mounts the real ReplApp, drives a turn that actually errors,
// and asserts the rendered frame shows the flash colour — so a future edit
// that drops `errorAt: state.lastErrorAt` from the <Editor/> call fails a
// test instead of silently regressing.
//
// withMotionForced (tests/helpers/motion_gate.mjs) forces motionEnabled()
// open, forces chalk.level so Ink's border colouring actually emits ANSI
// codes, and keeps the IME cursor-anchor effect's monkey-patch from
// installing — see that module's header comment for why each is needed.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('ReplApp: a failed turn flashes the input border red (wiring guard)', async () => {
  await withMotionForced(async () => {
    // Derive the flash colour's ANSI prefix from flashBorderColor itself
    // (age 0 is always inside the "on" phase) rather than duplicating the
    // hex literal from tui/editor.mjs.
    const flashHex = flashBorderColor(1, 1, true);
    const flashOpen = chalk.hex(flashHex)('X').split('X')[0];
    assert.ok(flashOpen.length > 0, 'sanity check: chalk.level forcing must actually produce an ANSI code');

    const instance = render(
      React.createElement(ReplApp, {
        splashProps: { provider: 'mock', model: 'm', version: '6.x', cwd: '/tmp', tools: [], skills: [] },
        runTurnFactory: () => async () => { throw new Error('boom'); },
      }),
    );
    try {
      await sleep(30);
      assert.equal(instance.lastFrame().includes(flashOpen), false,
        'precondition: the border must not be flashing before any turn has run');

      instance.stdin.write('hello');
      await sleep(40);
      instance.stdin.write('\r');

      // Deadline-based poll: the turn rejects asynchronously, so onTurnComplete's
      // setState + re-render land on a later tick, not synchronously with '\r'.
      const deadline = Date.now() + 3000;
      let flashed = false;
      while (Date.now() < deadline) {
        if (instance.frames.some((f) => f.includes(flashOpen))) { flashed = true; break; }
        await sleep(25);
      }
      assert.equal(flashed, true,
        'expected a frame with the flash colour after the turn errored — the errorAt prop wiring may be broken');
    } finally {
      try { instance.unmount(); } catch {}
      try { instance.cleanup(); } catch {}
    }
  });
});
