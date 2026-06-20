// tests/f-new-clear.test.mjs — `/new` must visually clear the screen.
//
// UX bug: /new resets the in-memory conversation (ctx.setMessages([]) in the
// dispatcher) but the Ink REPL's <Static/> scrollback array was never emptied,
// so the prior conversation kept showing on screen — directly contradicting
// the command's "clear conversation and start over" promise.
//
// Fix (tui/repl.mjs + tui/repl_reset.mjs): when onSlashCommand returns the
// 'NEW' reset sentinel (mirroring the existing 'EXIT' sentinel), the REPL
// applies the onConversationReset reducer, which empties the scrollback back
// to the splash item (the established fresh-start look) and clears the live
// region — so the screen visually starts over.
//
// What we pin here:
//   1. Pure reducer: onConversationReset empties the scrollback to splash-only
//      (and clears history / liveAssistant), discarding prior user/assistant
//      turns. Pre-fix this reducer did not exist.
//   2. Behavioral: a real Ink mount (ink-testing-library) renders the REPL,
//      submits a message, then triggers /new via an onSlashCommand that
//      returns 'NEW'. The REPL must wipe the terminal (clear-screen +
//      scrollback escape) — Ink's <Static/> output is write-once / append-only,
//      so resetting the React scrollback alone cannot un-print the old
//      conversation; the screen only starts fresh once the terminal is cleared.
//      Pre-fix neither the 'NEW' sentinel nor the clear were wired, so the old
//      conversation stayed on screen.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import {
  makeReplState,
  onUserInput,
  onStreamChunk,
  onTurnComplete,
  ReplApp,
} from '../tui/repl.mjs';
import { onConversationReset, CLEAR_TERMINAL } from '../tui/repl_reset.mjs';
import { _isInkResetCmd } from '../commands/chat.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 0. The Ink slash handler maps /new|/reset|/clear to the NEW sentinel ───
// _newReset returns a human string ('cleared — new conversation'), but repl.mjs
// only wipes the screen on the 'NEW' sentinel. The Ink handler must translate
// those reset commands to 'NEW' (like the 'EXIT' sentinel for /exit), or the
// real /new never clears the terminal.
test('_isInkResetCmd: /new, /reset, /clear signal the Ink NEW reset; others do not', () => {
  for (const c of ['/new', '/reset', '/clear', '/NEW']) assert.equal(_isInkResetCmd(c), true, c);
  for (const c of ['/usage', '/provider', '/help', '/news', '']) assert.equal(_isInkResetCmd(c), false, c);
});

// ─── 1. Pure reducer — reset empties the scrollback to splash-only ─────────

test('onConversationReset: empties scrollback to the splash item and clears history', () => {
  const splashItem = { kind: 'splash', id: 'splash-0', splashProps: {} };
  let s = makeReplState({ splashItem });
  // Build up a conversation: user line + assistant reply committed.
  s = onUserInput(s, { text: 'hello there', controller: { abort() {} } });
  s = onStreamChunk(s, { chunk: 'an assistant reply\n' });
  s = onTurnComplete(s, { reason: 'done' });

  // Sanity: the conversation is in the scrollback before reset.
  const before = s.scrollback.map((it) => it.text || '').join('\n');
  assert.match(before, /hello there/, 'precondition: user line is in scrollback');

  const next = onConversationReset(s);
  // Only the splash item survives; the conversation is gone.
  assert.equal(next.scrollback.length, 1, 'scrollback should hold only the splash item');
  assert.equal(next.scrollback[0], splashItem, 'the splash item must be preserved');
  assert.deepEqual(next.history, [], 'history must be cleared');
  assert.equal(next.liveAssistant, '', 'live region must be cleared');
  const after = next.scrollback.map((it) => it.text || '').join('\n');
  assert.doesNotMatch(after, /hello there/, 'prior user line must be gone after reset');
});

test('onConversationReset: with no splash item, scrollback becomes empty', () => {
  let s = makeReplState();
  s = onUserInput(s, { text: 'orphan line', controller: { abort() {} } });
  const next = onConversationReset(s);
  assert.deepEqual(next.scrollback, [], 'scrollback must be empty when there is no splash');
});

// ─── 2. Behavioral — /new wipes the terminal in a real Ink mount ───────────

test('ReplApp: /new (NEW sentinel) writes the clear-screen+scrollback escape so the screen starts fresh', async () => {
  const PRIOR = 'PRIOR_CONVERSATION_LINE';
  const instance = render(
    React.createElement(ReplApp, {
      splashProps: {
        provider: 'mock', model: 'm',
        version: '6.x', cwd: '/tmp', tools: [], skills: [],
      },
      runTurnFactory: () => async () => {},
      // Mimic cli.mjs's Ink slash handler: /new returns the reset sentinel.
      onSlashCommand: async (line) => (line === '/new' ? 'NEW' : 'ok\n'),
    }),
  );

  try {
    // Submit a normal message so it lands in the scrollback / frame.
    instance.stdin.write(PRIOR);
    await sleep(40);
    instance.stdin.write('\r');
    await sleep(80);
    assert.match(instance.lastFrame(), new RegExp(PRIOR),
      `precondition: ${PRIOR} should be visible in the frame after submit`);
    // The clear escape must NOT have been emitted yet (no /new run).
    assert.equal(instance.frames.some((f) => f.includes(CLEAR_TERMINAL)), false,
      'precondition: clear-terminal escape must not be written before /new');

    // Trigger /new. The dispatcher returns 'NEW'; the REPL resets scrollback
    // AND wipes the terminal (clear-screen + scrollback buffer).
    instance.stdin.write('/new');
    await sleep(40);
    instance.stdin.write('\r');

    // The REPL must emit the clear-screen+scrollback escape — the only way to
    // visually drop already-printed <Static/> output (write-once / append-only
    // in Ink). Without it the old conversation stays on screen (the bug).
    let cleared = false;
    for (let i = 0; i < 40; i++) {
      await sleep(25);
      if (instance.frames.some((f) => f.includes(CLEAR_TERMINAL))) { cleared = true; break; }
    }
    assert.equal(cleared, true,
      '/new did not wipe the terminal — the clear-screen+scrollback escape was never written (the bug)');
  } finally {
    try { instance.unmount(); } catch {}
    try { instance.cleanup(); } catch {}
  }
});
