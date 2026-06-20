// tests/f-cost-cap-accounting.test.mjs — the daemon cost cap (checkCostCap)
// was inert for /chat and /agent: cost only accumulated into metrics when the
// CALLER set BOTH body.usage and body.cost, which no bundled client does — so
// the running spend stayed 0 and the cap never tripped. accountTurnCost
// accumulates the turn's cost UNCONDITIONALLY when a rate card exists (so the
// cap tracks real spend) and only RETURNS the cost block when asked.

import test from 'node:test';
import assert from 'node:assert/strict';
import { accountTurnCost, checkCostCap } from '../daemon/lib/cost.mjs';

const freshMetrics = () => ({ costsByCurrency: {}, tokensTotal: { inputTokens: 0, outputTokens: 0 } });
const stubCost = () => ({ cost: 0.5, currency: 'USD' });

test('accountTurnCost accumulates cost into metrics even when the caller did not ask for it', () => {
  const metrics = freshMetrics();
  const ret = accountTurnCost({
    metrics, usage: { inputTokens: 10, outputTokens: 5 }, provider: 'openai', model: 'gpt-4',
    rates: { 'openai/gpt-4': {} }, wantCost: false, costFromUsage: stubCost,
  });
  assert.equal(metrics.costsByCurrency.USD, 0.5, 'cap must track real spend regardless of body.cost');
  assert.equal(metrics.tokensTotal.inputTokens, 10);
  assert.equal(ret, null, 'cost block is NOT returned unless wantCost');
});

test('accountTurnCost returns the cost block when wantCost is set', () => {
  const metrics = freshMetrics();
  const ret = accountTurnCost({ metrics, usage: { inputTokens: 1 }, provider: 'openai', model: 'gpt-4', rates: {}, wantCost: true, costFromUsage: stubCost });
  assert.deepEqual(ret, { cost: 0.5, currency: 'USD' });
});

test('accountTurnCost is a no-op with no usage or no rate card', () => {
  const m1 = freshMetrics();
  assert.equal(accountTurnCost({ metrics: m1, usage: null, rates: {}, wantCost: true, costFromUsage: stubCost }), null);
  const m2 = freshMetrics();
  assert.equal(accountTurnCost({ metrics: m2, usage: { inputTokens: 1 }, rates: null, wantCost: true, costFromUsage: stubCost }), null);
  assert.deepEqual(m1.costsByCurrency, {});
  assert.deepEqual(m2.costsByCurrency, {});
});

test('accumulated spend trips checkCostCap on the next request', () => {
  const metrics = freshMetrics();
  // Two turns at 0.5 each → 1.0 spent.
  accountTurnCost({ metrics, usage: { inputTokens: 1 }, rates: {}, wantCost: false, costFromUsage: stubCost });
  accountTurnCost({ metrics, usage: { inputTokens: 1 }, rates: {}, wantCost: false, costFromUsage: stubCost });
  assert.equal(checkCostCap(metrics, { USD: 0.9 })?.currency, 'USD', 'cap of 0.9 must be breached at 1.0 spent');
  assert.equal(checkCostCap(metrics, { USD: 2 }), null, 'cap of 2 is not yet breached');
});
