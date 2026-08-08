// tests/f-thinking-indicator.test.mjs — the gap between "message sent" and
// "first token" had no feedback. <Thinking/> fills it.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { Thinking, thinkingLabel } from '../tui/thinking.mjs';
import { SPINNER_FRAMES, motionEnabled } from '../tui/motion.mjs';
import { makeReplState, onUserInput, onStreamChunk } from '../tui/repl_reducers.mjs';
import { ReplApp } from '../tui/repl.mjs';
import { withMotionForced } from './helpers/motion_gate.mjs';
import { mountRepl } from './helpers/repl_harness.mjs';
import { makeScreen, plainText } from './helpers/vt_screen.mjs';

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

// ─── Mounted wiring guard ───────────────────────────────────────────────
//
// Every test above exercises <Thinking/> or the reducers in isolation, and none
// of them renders the `thinking…` string at all — under `node --test` the motion
// gate is shut, so Thinking({active: true}) returns null. That left the two
// `React.createElement(Thinking, …)` calls in tui/repl.mjs pinned by nothing:
// deleting both kept the whole suite green. This branch has now hit "correct
// component, unpinned wiring line" three times (Task 9's condition, Task 11's
// liveChars prop, this), so the wiring gets a mounted guard like the others.
//
// withMotionForced (tests/helpers/motion_gate.mjs) forces motionEnabled() open
// and keeps the IME cursor-anchor effect's process-wide monkey-patch from
// installing — see that module's header for why each mutation is needed.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Deadline-based rather than a fixed sleep: the indicator appears on a React
// re-render, and Ink's own render pass is throttled.
async function waitForFrame(instance, predicate, label) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate(instance)) return;
    await sleep(25);
  }
  assert.fail(`${label}\nlast frame:\n${instance.lastFrame()}`);
}

test('ReplApp: thinking… shows between submit and the first chunk, and goes away after it (wiring guard)', async () => {
  await withMotionForced(async () => {
    // The turn hangs until `release` is called, which is exactly the window the
    // indicator exists for: submitted, streaming, nothing received yet.
    let release;
    const turnGate = new Promise((resolve) => { release = resolve; });
    let emitChunk = null;
    const instance = render(
      React.createElement(ReplApp, {
        splashProps: { provider: 'mock', model: 'm', version: '6.x', cwd: '/tmp', tools: [], skills: [] },
        runTurnFactory: (write) => { emitChunk = write; return async () => { await turnGate; }; },
      }),
    );
    try {
      assert.equal(typeof emitChunk, 'function', 'sanity check: runTurnFactory must receive the chunk writer');
      await sleep(30);
      assert.equal(instance.lastFrame().includes('thinking…'), false,
        'precondition: nothing should be thinking before a turn is submitted');

      instance.stdin.write('hello');
      await sleep(40);
      instance.stdin.write('\r');
      await waitForFrame(instance, (i) => i.lastFrame().includes('thinking…'),
        'expected a frame showing thinking… while the turn had produced no output yet — the <Thinking/> wiring in tui/repl.mjs may be missing');

      // First token arrives: hasStreamedContent flips, so the indicator must go.
      emitChunk('first token');
      await waitForFrame(instance, (i) => !i.lastFrame().includes('thinking…'),
        'thinking… must disappear once content has streamed');
    } finally {
      release();
      try { instance.unmount(); } catch { /* already gone */ }
      try { instance.cleanup(); } catch { /* ignore */ }
    }
  });
});

// ─── Alt-buffer wiring guard ────────────────────────────────────────────
//
// tui/repl.mjs renders <Thinking/> a SECOND time, in the alt-buffer layout
// arm (the branch taken when POMPOS_ALT=1), ahead of the non-alt copy the
// test above pins. Nothing else in this suite ever exercises that arm —
// tests/helpers/repl_harness.mjs deletes POMPOS_ALT by default to pin the
// non-alt layout — so that copy was unpinned: deleting only the alt-buffer
// call leaves the whole suite green. mountRepl's `alt: true` option (added
// alongside this test) sets POMPOS_ALT=1 instead of deleting it, which is
// what computeAltEnabled (tui/repl_altbuffer.mjs) reads to pick the alt arm.
//
// Uses the vt_screen model rather than a raw substring check on h.bytes so
// the assertion reflects what is CURRENTLY on screen (post cursor-move /
// erase replay), the same standard tests/f-clear-splash-repaint.test.mjs and
// tests/f-hud-live-meter.test.mjs hold mounted-harness tests to.
function snapshotScreen(h) {
  const screen = makeScreen({ rows: 40, columns: 100 });
  for (const chunk of h.bytes) screen.write(chunk);
  return plainText(screen);
}

async function waitForScreen(h, predicate, label) {
  const deadline = Date.now() + 3000;
  let text = '';
  while (Date.now() < deadline) {
    text = snapshotScreen(h);
    if (predicate(text)) return;
    await sleep(25);
  }
  assert.fail(`${label}\nlast frame:\n${text}`);
}

test('ReplApp (alt-buffer): thinking… shows between submit and the first chunk (wiring guard)', async () => {
  await withMotionForced(async () => {
    // Same shape as the non-alt guard above: the turn hangs until `release`
    // is called, so the window under test is exactly submitted+streaming
    // with zero chunks received.
    let release;
    const turnGate = new Promise((resolve) => { release = resolve; });
    const h = mountRepl(
      {
        splashProps: { provider: 'mock', model: 'm', version: '6.x', cwd: '/tmp', tools: [], skills: [] },
        runTurnFactory: () => async () => { await turnGate; },
      },
      { alt: true },
    );
    try {
      await h.settle();
      assert.equal(snapshotScreen(h).includes('thinking…'), false,
        'precondition: nothing should be thinking before a turn is submitted');

      h.type('hello');
      await h.settle(40);
      h.type('\r');
      await waitForScreen(h, (text) => text.includes('thinking…'),
        'expected a frame showing thinking… while the turn had produced no output yet (alt-buffer arm) — the <Thinking/> wiring in tui/repl.mjs\'s alt-buffer branch may be missing');
    } finally {
      release();
      h.unmount();
    }
  });
});
