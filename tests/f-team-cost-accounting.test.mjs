// tests/f-team-cost-accounting.test.mjs
//
// A channel bound to a team ran a multi-agent loop whose spend never reached
// the cost cap: team agent turns reported no usage and the inbound route never
// accounted them. makeTeamUsageAccountant closes that gap — it prices each
// agent turn against its own rate card, accumulates into metrics so the cap
// tracks team spend, and fires onBreach (the daemon aborts the loop) once the
// cap trips. routeInboundToTeam forwards the onUsage + signal through.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTeamUsageAccountant } from '../daemon/lib/cost.mjs';
import { costFromUsage } from '../providers/rates.mjs';
import { routeInboundToTeam } from '../daemon/lib/team_inbound.mjs';
import { registerAgent } from '../agents.mjs';
import { registerTeam } from '../teams.mjs';

const freshMetrics = () => ({ costsByCurrency: {}, tokensTotal: { inputTokens: 0, outputTokens: 0 } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-tca-'));

test('accountant accumulates spend and fires onBreach once the cap is exceeded', () => {
  const metrics = freshMetrics();
  const rates = { 'anthropic/claude-opus-4-7': { inputPer1M: 15, outputPer1M: 75 } };
  let breached = 0;
  const onUsage = makeTeamUsageAccountant({ metrics, costCap: { USD: 50 }, rates, costFromUsage, onBreach: () => { breached++; } });
  onUsage({ provider: 'anthropic', model: 'claude-opus-4-7', usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } });
  assert.equal(Math.round(metrics.costsByCurrency.USD), 90, 'spend = 15 (in) + 75 (out)');
  assert.equal(metrics.tokensTotal.inputTokens, 1_000_000);
  assert.equal(breached, 1, 'cap of $50 exceeded by $90 → onBreach fires');
});

test('accountant does not fire onBreach below the cap', () => {
  const metrics = freshMetrics();
  const rates = { 'anthropic/m': { inputPer1M: 1, outputPer1M: 1 } };
  let breached = 0;
  const onUsage = makeTeamUsageAccountant({ metrics, costCap: { USD: 1000 }, rates, costFromUsage, onBreach: () => { breached++; } });
  onUsage({ provider: 'anthropic', model: 'm', usage: { inputTokens: 1000, outputTokens: 1000 } });
  assert.equal(breached, 0, 'tiny spend stays under a $1000 cap');
});

test('accountant tolerates missing rates without throwing or accruing', () => {
  const metrics = freshMetrics();
  const onUsage = makeTeamUsageAccountant({ metrics, costCap: { USD: 1 }, rates: null, costFromUsage, onBreach: () => { throw new Error('must not breach'); } });
  onUsage({ provider: 'x', model: 'y', usage: { inputTokens: 5, outputTokens: 5 } });
  assert.deepEqual(metrics.costsByCurrency, {}, 'no rate card → no cost accrued (and no breach)');
});

test('routeInboundToTeam forwards onUsage and signal to runTaskTurn', async () => {
  const d = tmp();
  registerAgent({ name: 'lead', provider: 'claude-cli' }, d);
  registerTeam({ name: 'solo', agents: ['lead'], lead: 'lead', slackChannel: 'C-s' }, d);
  let captured = null;
  const fakeRun = async (args) => { captured = args; return { task: { id: args.task.id, turns: [{ agent: 'lead', text: 'hi' }] } }; };
  const onUsage = () => {};
  const ac = new AbortController();
  await routeInboundToTeam({ cfg: {}, channel: 'C-s', text: 'go', configDir: d, onUsage, signal: ac.signal, _runTaskTurn: fakeRun });
  assert.equal(captured.onUsage, onUsage, 'onUsage must be forwarded to runTaskTurn');
  assert.equal(captured.signal, ac.signal, 'signal must be forwarded to runTaskTurn');
  fs.rmSync(d, { recursive: true, force: true });
});
