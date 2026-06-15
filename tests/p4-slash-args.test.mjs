// tests/p4-slash-args.test.mjs — argSpecFor resolves which argument is
// completable (position/subcommand-aware, inline vs modal); listArgCandidates
// builds inline lists; runArgCompleter drives the modal drill-in.

import test from 'node:test';
import assert from 'node:assert/strict';
import { argSpecFor, runArgCompleter, listArgCandidates } from '../tui/slash_args.mjs';
import { SLASH_COMMANDS as CAT } from '../tui/slash_commands.mjs';

test('argSpecFor: /model is a modal (drill-in) arg', () => {
  const s = argSpecFor('/model gpt', CAT);
  assert.equal(s.kind, 'modal');
  assert.equal(s.completer, 'model');
  assert.equal(s.partial, 'gpt');
});

test('argSpecFor: /login is an inline arg', () => {
  const s = argSpecFor('/login co', CAT);
  assert.equal(s.kind, 'inline');
  assert.equal(s.completer, 'loginProvider');
  assert.equal(s.partial, 'co');
});

test('argSpecFor: subcommand menus complete the first token (inline)', () => {
  assert.equal(argSpecFor('/trainer sh', CAT).completer, 'trainerSub');
  assert.equal(argSpecFor('/orchestrator st', CAT).completer, 'orchestratorSub');
  assert.equal(argSpecFor('/task ', CAT).completer, 'taskSub');
  assert.equal(argSpecFor('/memory ', CAT).completer, 'memoryScope');
  assert.equal(argSpecFor('/hud ', CAT).completer, 'onoff');
});

test('argSpecFor: value args gate on the subcommand', () => {
  assert.equal(argSpecFor('/trainer set anth', CAT).kind, 'modal'); // provider->model spec
  assert.equal(argSpecFor('/orchestrator planner ', CAT).completer, 'orchestratorSpec');
  assert.equal(argSpecFor('/agent edit sc', CAT).completer, 'agentName');
  assert.equal(argSpecFor('/personality use de', CAT).completer, 'personalityName');
  assert.equal(argSpecFor('/channels slack ', CAT).completer, 'channelAction'); // 2nd token: on|off|setup
});

test('argSpecFor: null when no rule / no space', () => {
  assert.equal(argSpecFor('/help foo', CAT), null);
  assert.equal(argSpecFor('/model', CAT), null);
});

test('listArgCandidates: login providers, filtered by partial', () => {
  const items = listArgCandidates(argSpecFor('/login ', CAT), {});
  const vals = items.map((i) => i.value);
  assert.ok(vals.includes('codex-cli'));
  assert.ok(vals.includes('gemini-cli'));
  // partial 'gem' narrows
  const narrowed = listArgCandidates(argSpecFor('/login gem', CAT), {}).map((i) => i.value);
  assert.deepEqual(narrowed, ['gemini-cli']);
});

test('listArgCandidates: hud on/off enum', () => {
  assert.deepEqual(listArgCandidates(argSpecFor('/hud ', CAT), {}).map((i) => i.value), ['on', 'off']);
});

test('listArgCandidates: provider list comes from the registry', async () => {
  const registry = await import('../providers/registry.mjs');
  const vals = listArgCandidates(argSpecFor('/provider an', CAT), {}, registry).map((i) => i.value);
  assert.ok(vals.includes('anthropic'));
});

test('listArgCandidates returns [] for a modal spec', () => {
  assert.deepEqual(listArgCandidates(argSpecFor('/model gpt', CAT), {}), []);
});

test('argSpecFor: handoff/dashboard/goal/channels rules; /config has none', () => {
  assert.equal(argSpecFor('/handoff ', CAT).completer, 'channelName');
  assert.equal(argSpecFor('/dashboard ', CAT).completer, 'dashboardSub');
  assert.equal(argSpecFor('/goal ', CAT).completer, 'goalFirst');
  assert.equal(argSpecFor('/goal close g1 ', CAT).completer, 'goalOutcome');
  assert.equal(argSpecFor('/channels ', CAT).completer, 'channelFirst');
  assert.equal(argSpecFor('/channels slack ', CAT).completer, 'channelAction');
  assert.equal(argSpecFor('/config ', CAT), null); // /config opens its own picker; no inline arg
});

test('listArgCandidates: /channels first token includes setup + channels; /handoff lists channels', () => {
  const first = listArgCandidates(argSpecFor('/channels ', CAT), {}).map((i) => i.value);
  assert.ok(first.includes('setup') && first.includes('slack') && first.includes('telegram'));
  const action = listArgCandidates(argSpecFor('/channels slack ', CAT), {}).map((i) => i.value);
  assert.deepEqual(action, ['on', 'off', 'setup', 'test']);
  const handoff = listArgCandidates(argSpecFor('/handoff ', CAT), {}).map((i) => i.value);
  assert.ok(handoff.includes('slack') && handoff.includes('telegram'));
  assert.deepEqual(listArgCandidates(argSpecFor('/dashboard ', CAT), {}).map((i) => i.value), ['stop', 'kill']);
});

test('runArgCompleter drives the modal model completer', async () => {
  const ctx = {
    getActiveProvName: () => 'anthropic', getActiveModel: () => '',
    resolveAuthKey: () => '', cfg: {},
    openPicker: async () => 'claude-opus-4-8',
  };
  const registry = await import('../providers/registry.mjs');
  const spec = argSpecFor('/model claude', CAT);
  assert.equal(await runArgCompleter(spec, ctx, registry), 'claude-opus-4-8');
});
