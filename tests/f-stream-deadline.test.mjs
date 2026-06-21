// tests/f-stream-deadline.test.mjs
//
// The daemon's streaming providers only had a per-chunk idle timeout, so a
// model that streams steadily could run unbounded. armStreamDeadline adds an
// opt-in wall-clock cap (cfg.chat.maxStreamMs): after maxMs it aborts the
// turn's AbortController, and hit() lets the caller tell the client the reply
// was truncated by the cap (vs a client disconnect). These pin that contract;
// the conversation loops treat an unset/<=0 cap as a no-op so existing streams
// are byte-stable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { armStreamDeadline } from '../daemon/lib/respond.mjs';

test('armStreamDeadline aborts the controller after maxMs and reports hit()', async () => {
  const ac = new AbortController();
  const dl = armStreamDeadline(ac, 20);
  assert.equal(dl.hit(), false);
  assert.equal(ac.signal.aborted, false);
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(ac.signal.aborted, true, 'controller aborted after the deadline');
  assert.equal(dl.hit(), true, 'hit() reports the deadline fired');
  dl.disarm();
});

test('disarm prevents the deadline from firing', async () => {
  const ac = new AbortController();
  const dl = armStreamDeadline(ac, 20);
  dl.disarm();
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(ac.signal.aborted, false, 'a disarmed deadline must not abort');
  assert.equal(dl.hit(), false);
});

test('a non-positive or unset maxMs is a no-op', async () => {
  const ac = new AbortController();
  assert.equal(armStreamDeadline(ac, 0).hit(), false);
  assert.equal(armStreamDeadline(ac, undefined).hit(), false);
  assert.equal(armStreamDeadline(ac, -5).hit(), false);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ac.signal.aborted, false, 'no cap → never aborts');
});
