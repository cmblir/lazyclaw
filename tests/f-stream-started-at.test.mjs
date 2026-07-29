// tests/f-stream-started-at.test.mjs — pins the streamStartedAt reducer
// lifecycle end to end. This field is set by onUserInput's idle branch
// (tui/repl_reducers.mjs) and cleared on every path back to idle: turn
// completion, Esc, and a full conversation reset (tui/repl_reset.mjs).
// It lives in its own file rather than being folded into an existing test
// file because the invariant spans two separate reducer modules
// (repl_reducers.mjs + repl_reset.mjs) and no existing test file's stated
// scope (interrupt handling, /new-clear, status-bar rendering, ...) covers
// that cross-module lifecycle without blurring its own single responsibility.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeReplState, onUserInput, onEscape, onTurnComplete } from '../tui/repl_reducers.mjs';
import { onConversationReset } from '../tui/repl_reset.mjs';

test('makeReplState starts streamStartedAt null, with or without a splash item', () => {
  assert.equal(makeReplState().streamStartedAt, null);
  const splashItem = { kind: 'splash', id: 'splash-0', splashProps: {} };
  assert.equal(makeReplState({ splashItem }).streamStartedAt, null);
});

test("onUserInput's idle branch sets streamStartedAt to a finite time close to now", () => {
  const before = Date.now();
  let s = makeReplState();
  s = onUserInput(s, { text: 'hi', controller: { abort: () => {} } });
  const after = Date.now();
  assert.ok(Number.isFinite(s.streamStartedAt), `expected a finite timestamp, got: ${s.streamStartedAt}`);
  assert.ok(s.streamStartedAt >= before && s.streamStartedAt <= after,
    `expected streamStartedAt in [${before}, ${after}], got: ${s.streamStartedAt}`);
});

test('onTurnComplete clears streamStartedAt back to null', () => {
  let s = makeReplState();
  s = onUserInput(s, { text: 'hi', controller: { abort: () => {} } });
  assert.notEqual(s.streamStartedAt, null);
  s = onTurnComplete(s, { reason: 'done' });
  assert.equal(s.streamStartedAt, null);
});

test('onEscape clears streamStartedAt back to null', () => {
  let s = makeReplState();
  s = onUserInput(s, { text: 'hi', controller: { abort: () => {} } });
  assert.notEqual(s.streamStartedAt, null);
  s = onEscape(s);
  assert.equal(s.streamStartedAt, null);
});

test('onConversationReset clears streamStartedAt back to null', () => {
  let s = makeReplState();
  s = onUserInput(s, { text: 'hi', controller: { abort: () => {} } });
  assert.notEqual(s.streamStartedAt, null);
  s = onConversationReset(s);
  assert.equal(s.streamStartedAt, null);
});

test("a mid-stream interrupt does NOT overwrite the in-flight turn's streamStartedAt", () => {
  // While streaming (state.streaming && state.controller truthy), onUserInput
  // takes the interrupt branch — abort + queue pendingPrepend — and returns
  // `{ ...state, pendingPrepend: text }`. It spreads the existing state and
  // only overrides pendingPrepend, so streamStartedAt is left exactly as-is;
  // the original turn's clock keeps running until that turn actually ends.
  let s = makeReplState();
  s = onUserInput(s, { text: 'first task', controller: { abort: () => {} } });
  const startedAt = s.streamStartedAt;
  assert.notEqual(startedAt, null);

  s = onUserInput(s, { text: 'oh wait, do this instead', controller: { abort: () => {} } });
  assert.equal(s.streamStartedAt, startedAt, 'the interrupt branch must not touch streamStartedAt');
  assert.equal(s.pendingPrepend, 'oh wait, do this instead');
});
