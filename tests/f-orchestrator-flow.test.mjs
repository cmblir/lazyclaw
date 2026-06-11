// tests/f-orchestrator-flow.test.mjs — editing the orchestrator's planner /
// workers (and a provider's model) by fetch+pick instead of typing
// "provider:model" specs. Drives the modal via a scripted openPicker.

import test from 'node:test';
import assert from 'node:assert/strict';
import { orchestratorAction, pickModelForProvider, pickAndSetModel, orchestratorSlash } from '../tui/orchestrator_flow.mjs';

const registry = {
  PROVIDERS: { openai: {}, 'claude-cli': {}, ollama: {}, orchestrator: {}, mock: {} },
  PROVIDER_INFO: {
    openai: { suggestedModels: ['gpt-5', 'gpt-4.1'], defaultModel: 'gpt-4.1' },
    'claude-cli': { suggestedModels: ['opus', 'sonnet'], defaultModel: 'opus' },
    ollama: { suggestedModels: ['llama3.1'] },
  },
};

// ctx whose openPicker replays a scripted sequence of returns.
function scriptedCtx(returns) {
  let i = 0;
  const cfg = { provider: 'claude-cli', orchestrator: {} };
  return {
    cfg, readConfig: () => cfg, writeConfig: (n) => Object.assign(cfg, n),
    resolveAuthKey: () => '',
    setActiveModel: () => {},
    openPicker: async () => (i < returns.length ? returns[i++] : null),
  };
}

test('pickModelForProvider: provider-default sentinel returns empty string', async () => {
  const ctx = scriptedCtx(['__default__']);
  assert.equal(await pickModelForProvider(ctx, registry, 'openai'), '');
});

test('pickModelForProvider: a concrete model id passes through', async () => {
  const ctx = scriptedCtx(['gpt-4.1']);
  assert.equal(await pickModelForProvider(ctx, registry, 'openai'), 'gpt-4.1');
});

test('orchestratorAction planner: provider then model → "provider:model" spec', async () => {
  const ctx = scriptedCtx(['openai', 'gpt-4.1']);
  const r = await orchestratorAction(ctx, registry, 'planner');
  assert.match(r, /planner → openai:gpt-4\.1/);
  assert.equal(ctx.cfg.orchestrator.planner, 'openai:gpt-4.1');
});

test('orchestratorAction planner: model "provider default" → bare provider spec', async () => {
  const ctx = scriptedCtx(['ollama', '__default__']);
  const r = await orchestratorAction(ctx, registry, 'planner');
  assert.match(r, /planner → ollama$/);
  assert.equal(ctx.cfg.orchestrator.planner, 'ollama');
});

test('orchestratorAction worker-add then worker-remove', async () => {
  const ctx = scriptedCtx(['claude-cli', 'opus']);
  await orchestratorAction(ctx, registry, 'worker-add');
  assert.deepEqual(ctx.cfg.orchestrator.workers, ['claude-cli:opus']);
  // remove it (one openPicker pick of the existing worker)
  const ctx2 = { ...ctx, openPicker: async () => 'claude-cli:opus' };
  const r = await orchestratorAction(ctx2, registry, 'worker-remove');
  assert.match(r, /\(none\)/);
});

test('orchestratorAction maxsubtasks: numeric pick clamps + persists', async () => {
  const ctx = scriptedCtx(['7']);
  const r = await orchestratorAction(ctx, registry, 'maxsubtasks');
  assert.match(r, /maxSubtasks → 7/);
  assert.equal(ctx.cfg.orchestrator.maxSubtasks, 7);
});

test('pickAndSetModel persists cfg.model (or clears it for default)', async () => {
  const ctx = scriptedCtx(['gpt-4.1']);
  const r = await pickAndSetModel(ctx, registry, 'openai');
  assert.match(r, /model → gpt-4\.1/);
  assert.equal(ctx.cfg.model, 'gpt-4.1');
  const ctx2 = scriptedCtx(['__default__']);
  await pickAndSetModel(ctx2, registry, 'openai');
  assert.equal(ctx2.cfg.model, undefined);
});

test('orchestratorSlash text subcommands still work (no modal)', async () => {
  const cfg = { provider: 'claude-cli', orchestrator: {} };
  const ctx = { readConfig: () => cfg, writeConfig: (n) => Object.assign(cfg, n) };
  assert.match(await orchestratorSlash('planner openai:gpt-4.1', ctx), /planner → openai:gpt-4\.1/);
  assert.match(await orchestratorSlash('status', ctx), /planner: openai:gpt-4\.1/);
});
