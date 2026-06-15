// tests/p4-render-record.test.mjs — renderRecord turns a record into readable
// key: value lines (replaces raw JSON dumps in the *show handlers).

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRecord, renderRecordOrJson } from '../lib/render.mjs';

test('renderRecord emits key: value lines in field order', () => {
  const out = renderRecord({ name: 'scout', provider: 'anthropic', model: 'claude-opus-4-8', extra: 'x' },
    { fields: ['name', 'provider', 'model'] });
  assert.equal(out, 'name: scout\nprovider: anthropic\nmodel: claude-opus-4-8');
});

test('renderRecord formats empties, arrays, and nested objects', () => {
  const out = renderRecord({ a: '', b: ['x', 'y'], c: [], d: { p: 1, q: 'z' } });
  assert.match(out, /^a: \(none\)$/m);
  assert.match(out, /^b: \[x, y\]$/m);
  assert.match(out, /^c: \[\]$/m);
  assert.match(out, /^d: \{p: 1, q: z\}$/m);
});

test('renderRecord skips fields absent on the object', () => {
  const out = renderRecord({ name: 'a' }, { fields: ['name', 'missing'] });
  assert.equal(out, 'name: a');
});

test('renderRecord hide list omits keys when no fields given', () => {
  const out = renderRecord({ name: 'a', secret: 's' }, { hide: ['secret'] });
  assert.equal(out, 'name: a');
});

test('renderRecordOrJson switches on raw flag', () => {
  const obj = { name: 'a' };
  assert.equal(renderRecordOrJson(obj, { fields: ['name'] }, false), 'name: a');
  assert.equal(renderRecordOrJson(obj, { fields: ['name'] }, true), JSON.stringify(obj, null, 2));
});
