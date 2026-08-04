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
