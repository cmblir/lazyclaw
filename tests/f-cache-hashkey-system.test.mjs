// tests/f-cache-hashkey-system.test.mjs
//
// withResponseCache's hashKey only folded opts.system into the key — it ignored
// opts.systemStatic and opts.systemVolatile. The REPL caller passes its system
// prompt as systemStatic (never opts.system), so two calls with the SAME
// messages array but a DIFFERENT static system would collide on the same key
// and the second could be served the first's cached reply. These pin that the
// static/volatile system fields (and an embedded role:system message) all
// participate in the key, while identical inputs still hash identically.

import test from 'node:test';
import assert from 'node:assert/strict';
import { hashKey } from '../providers/cache.mjs';

const U = [{ role: 'user', content: 'hi' }];

test('systemStatic participates in the key (no false hit on a different static system)', () => {
  assert.notEqual(
    hashKey(U, 'm', { systemStatic: 'You are A' }),
    hashKey(U, 'm', { systemStatic: 'You are B' }),
  );
});

test('systemVolatile participates in the key', () => {
  assert.notEqual(
    hashKey(U, 'm', { systemVolatile: 'context A' }),
    hashKey(U, 'm', { systemVolatile: 'context B' }),
  );
});

test('an embedded role:system message feeds the dedicated system field', () => {
  assert.notEqual(
    hashKey([{ role: 'system', content: 'persona A' }, ...U], 'm', {}),
    hashKey([{ role: 'system', content: 'persona B' }, ...U], 'm', {}),
  );
});

test('identical inputs still hash identically so the cache can hit', () => {
  const opts = { systemStatic: 'S', tools: ['x'] };
  assert.equal(
    hashKey(U, 'm', opts),
    hashKey(U, 'm', { ...opts }),
  );
});
