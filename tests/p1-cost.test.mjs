// P1 — cost is observable/enforceable on the subscription path: a
// provider-reported total_cost_usd is preferred over rate-card arithmetic,
// so the cap works even with no (or a zero-filled) rate card.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costFromUsage } from '../providers/rates.mjs';

test('prefers provider-reported total_cost_usd, no rate card needed', () => {
  const c = costFromUsage({ provider: 'claude-cli', model: 'opus', usage: { totalCostUsd: 0.0042 } }, null);
  assert.ok(c);
  assert.equal(c.cost, 0.0042);
  assert.equal(c.currency, 'USD');
  assert.equal(c.breakdown.reported, 0.0042);
});

test('falls back to the rate card when there is no reported cost', () => {
  const c = costFromUsage(
    { provider: 'openai', model: 'gpt', usage: { inputTokens: 1_000_000, outputTokens: 0 } },
    { 'openai/gpt': { inputPer1M: 2, outputPer1M: 8, currency: 'USD' } },
  );
  assert.equal(c.cost, 2);
});

test('returns null when there is neither a reported cost nor a matching card', () => {
  assert.equal(costFromUsage({ provider: 'x', model: 'y', usage: {} }, {}), null);
  assert.equal(costFromUsage({ provider: 'x', model: 'y', usage: {} }, null), null);
});
