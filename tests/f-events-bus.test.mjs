import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emit, subscribe, recent, _reset } from '../mas/events.mjs';

test('emit delivers to subscribers and stamps seq/ts/type', () => {
  _reset();
  const got = [];
  const unsub = subscribe((e) => got.push(e));
  emit('tool.call', { agent: 'a', tool: 'bash', ok: true });
  assert.equal(got.length, 1);
  assert.equal(got[0].type, 'tool.call');
  assert.equal(got[0].agent, 'a');
  assert.ok(got[0].seq >= 1);
  assert.ok(got[0].ts > 0);
  unsub();
  emit('x', {});
  assert.equal(got.length, 1, 'unsubscribe stops delivery');
});

test('recent() replays the ring buffer, optionally since a seq', () => {
  _reset();
  emit('a', {}); emit('b', {});
  const r = recent();
  assert.deepEqual(r.map((e) => e.type), ['a', 'b']);
  assert.deepEqual(recent(r[0].seq).map((e) => e.type), ['b']);
});

test('ring buffer is bounded and keeps the newest events', () => {
  _reset();
  for (let i = 0; i < 250; i++) emit('e', { i });
  const r = recent();
  assert.ok(r.length <= 200, `ring should cap at 200, got ${r.length}`);
  assert.equal(r[r.length - 1].i, 249);
});

test('a throwing subscriber never breaks emit or other subscribers', () => {
  _reset();
  const got = [];
  subscribe(() => { throw new Error('bad subscriber'); });
  subscribe((e) => got.push(e));
  assert.doesNotThrow(() => emit('e', {}));
  assert.equal(got.length, 1);
});
