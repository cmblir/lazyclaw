// tests/f-orchestrator-config.test.mjs — orchestrator config helpers + the
// /orchestrator slash, and the relaxed Slack inbound requirement (Socket Mode
// needs only bot + app token, not the signing secret).

import test from 'node:test';
import assert from 'node:assert/strict';
import { orchestratorGet, orchestratorSet, orchestratorEnable } from '../config_features.mjs';
import { dispatchSlash } from '../tui/slash_dispatcher.mjs';
import { SLASH_COMMANDS } from '../tui/slash_commands.mjs';

test('orchestratorGet reports planner/workers/active', () => {
  assert.deepEqual(orchestratorGet({}), { planner: null, workers: [], maxSubtasks: 5, active: false });
  const cfg = { provider: 'orchestrator', orchestrator: { planner: 'claude-cli', workers: ['mock'] } };
  const s = orchestratorGet(cfg);
  assert.equal(s.active, true, 'active when provider=orchestrator AND workers present');
  assert.deepEqual(s.workers, ['mock']);
});

test('orchestratorGet not active when provider=orchestrator but no workers', () => {
  assert.equal(orchestratorGet({ provider: 'orchestrator', orchestrator: { workers: [] } }).active, false);
});

test('orchestratorEnable stashes + restores the previous provider', () => {
  const cfg = { provider: 'claude-cli' };
  orchestratorEnable(cfg, true);
  assert.equal(cfg.provider, 'orchestrator');
  assert.equal(cfg.orchestrator._prevProvider, 'claude-cli');
  orchestratorEnable(cfg, false);
  assert.equal(cfg.provider, 'claude-cli', 'disable restores the stashed provider');
});

test('orchestratorSet merges only provided keys', () => {
  const cfg = { orchestrator: { planner: 'a', workers: ['w1'] } };
  orchestratorSet(cfg, { workers: ['w1', 'w2'] });
  assert.equal(cfg.orchestrator.planner, 'a', 'planner preserved');
  assert.deepEqual(cfg.orchestrator.workers, ['w1', 'w2']);
});

test('/orchestrator slash: worker add then on toggles provider', async () => {
  const cfg = { provider: 'claude-cli' };
  const ctx = { readConfig: () => cfg, writeConfig: (c) => Object.assign(cfg, c) };
  await dispatchSlash('/orchestrator', 'worker add mock', ctx, () => {});
  assert.deepEqual(cfg.orchestrator.workers, ['mock']);
  const on = await dispatchSlash('/orchestrator', 'on', ctx, () => {});
  assert.match(on, /orchestration ON/);
  assert.equal(cfg.provider, 'orchestrator');
  const off = await dispatchSlash('/orchestrator', 'off', ctx, () => {});
  assert.match(off, /orchestration off/);
  assert.equal(cfg.provider, 'claude-cli');
});

test('/orchestrator is in the slash catalog', () => {
  assert.ok(SLASH_COMMANDS.some((c) => c.cmd === '/orchestrator'));
});

test('Slack inbound requires bot + app token but NOT the signing secret', async () => {
  const { SlackChannel } = await import('../channels/slack.mjs');
  const ch = new SlackChannel({ botToken: null, appToken: null, signingSecret: null, apiBase: 'http://127.0.0.1:1', requireInbound: true });
  let err = null;
  try { await ch.start(async () => 'r'); } catch (e) { err = e; }
  assert.ok(err, 'missing tokens throw');
  assert.equal(err.code, 'SLACK_MISSING_ENV');
  assert.ok(err.missing.includes('SLACK_BOT_TOKEN'));
  assert.ok(err.missing.includes('SLACK_APP_TOKEN'));
  assert.ok(!err.missing.includes('SLACK_SIGNING_SECRET'), 'signing secret is no longer required for Socket Mode');
});
