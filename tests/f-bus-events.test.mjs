// tests/f-bus-events.test.mjs — the four events the live rail needs beyond the
// MAS team path. Payloads carry routing facts only: a channel message body or
// a provider key in here would leak into every subscribed dashboard.
//
// `emit` spreads the payload into the stamped event ({seq, ts, type, ...payload},
// mas/events.mjs:24), which is why the forbidden-key scan below can read payload
// fields straight off `Object.keys(e)`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emit, subscribe, recent, _reset } from '../mas/events.mjs';

test('the new event types stamp seq and ts like the existing ones', () => {
  _reset();
  const seen = [];
  const off = subscribe((e) => seen.push(e));
  // `done`/`total`, not `step`/`total`: the DAG runner completes a whole
  // topological level at once, so a single "current step index" does not exist
  // there. `node` is the node id — compileWorkflow keeps no name field.
  emit('workflow.step', { id: 'sess_x', done: 3, total: 5, node: 'summarise' });
  emit('cost.tick', { total: 0.83, cap: 5, currency: 'USD' });
  emit('channel.inbound', { channel: '#ship-it', to: 'orchestrator', team: 'ship-it' });
  emit('provider.error', { provider: 'ollama', detail: 'unreachable' });
  off();
  assert.equal(seen.length, 4);
  for (const e of seen) {
    assert.ok(Number.isInteger(e.seq) && e.seq > 0);
    assert.ok(Number.isFinite(e.ts));
  }
  assert.equal(recent().length, 4);
});

test('no new payload carries a secret-shaped field', () => {
  _reset();
  const seen = [];
  const off = subscribe((e) => seen.push(e));
  emit('channel.inbound', { channel: '#ship-it', to: 'orchestrator', team: 'ship-it' });
  emit('provider.error', { provider: 'ollama', detail: 'unreachable' });
  off();
  const FORBIDDEN = /token|secret|apikey|api_key|password|authorization|text|body|message/i;
  for (const e of seen) {
    for (const k of Object.keys(e)) {
      assert.doesNotMatch(k, FORBIDDEN, `${e.type} must not carry a "${k}" field`);
    }
  }
});

// Scanning key NAMES is only half the property, and the weaker half. A field
// called `detail` passes the scan above while carrying 200 characters of a
// provider's raw HTTP error body — which is exactly what provider.error did
// until this test was added, because anthropic.mjs's ApiError builds its message
// from `body.slice(0, 200)` and sets no `code` for the intended branch to find.
// These events reach every connected dashboard over SSE, so the VALUES need a
// bound of their own.
//
// There is deliberately no generic value-length scan across all four event
// types here. `workflow.step`, `cost.tick` and `channel.inbound` each build
// their payload inline at their emit call site (workflow/persistent.mjs,
// daemon/lib/cost.mjs, daemon/lib/team_inbound.mjs) with no derivation logic
// to extract into a pure function — a scan could only ever run over literals
// this test authored itself, which is a tautology: it would pass unchanged
// against the shipped 343-character `provider.error` leak it was meant to
// catch. `provider.error` is different because `_detailForFallback` below IS
// an extracted, production-called function, so the test after this comment
// exercises real behaviour instead of its own fixtures. An acknowledged gap
// here is more honest than a guard that cannot fail.

// The emit site itself, not just the payload shape. This is the assertion that
// would have failed on the shipped code: an ApiError carrying a 200-character
// body in `message` and no `code` must still produce a short, non-content detail.
test('provider.error derives detail from code/status/name, never the error message', async () => {
  const { _detailForFallback } = await import('../daemon/lib/provider.mjs');
  const apiErr = Object.assign(
    new Error('anthropic api 429: ' + JSON.stringify({ error: { message: 'x'.repeat(300) } })),
    { name: 'AnthropicApiError', status: 429 },
  );
  const detail = _detailForFallback(apiErr);
  assert.equal(detail, '429', 'status wins over the message');
  assert.ok(!detail.includes('anthropic api'), 'no fragment of the message survives');

  assert.equal(_detailForFallback(Object.assign(new Error('boom'), { code: 'ECONNREFUSED' })),
    'ECONNREFUSED', 'code wins when present');
  assert.equal(_detailForFallback(new Error('a'.repeat(500))), 'Error',
    'with neither code nor status it falls back to the name, never the message');
  assert.equal(_detailForFallback(undefined), 'failed');
  assert.ok(_detailForFallback(Object.assign(new Error('x'), { code: 'y'.repeat(200) })).length <= 40,
    'even a pathological code is capped');
});
