// tests/f-sse-backpressure.test.mjs
//
// The SSE streaming loops paid a full event-loop turn (await setImmediate) on
// EVERY token, even when the socket's write buffer wasn't full. writeSse now
// returns the data-frame res.write() result so the loops can yield only under
// real backpressure. These pin that return contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeSse } from '../daemon/lib/respond.mjs';

test('writeSse returns false when the data write signals a full buffer', () => {
  // res.write returns false for the data frame (backpressure).
  const res = { write: (s) => !String(s).startsWith('data:') };
  assert.equal(writeSse(res, 'token', { text: 'hi' }), false);
});

test('writeSse returns true when the socket buffer is not full', () => {
  const res = { write: () => true };
  assert.equal(writeSse(res, 'token', { text: 'hi' }), true);
});

test('writeSse without an event still returns the data write result', () => {
  const res = { write: () => false };
  assert.equal(writeSse(res, null, { x: 1 }), false);
});
