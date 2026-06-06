// tests/p3-model-switch.test.mjs — the user is on ollama but wants to reach
// the connected claude-cli models (opus/sonnet/haiku) from /model without
// first running /provider. Add a "⇄ switch provider" row to the model picker.

import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchSlash } from '../tui/slash_dispatcher.mjs';

function makeCtx() {
  let provName = 'ollama';
  let model = null;
  let prov = { id: provName };
  const PROVIDERS = { ollama: { id: 'ollama' }, 'claude-cli': { id: 'claude-cli' }, mock: { id: 'mock' }, orchestrator: { id: 'orchestrator' } };
  const PROVIDER_INFO = {
    ollama: { name: 'ollama', defaultModel: 'llama3.1', suggestedModels: ['llama3.1', 'llama3.3'] },
    'claude-cli': { name: 'claude-cli', defaultModel: 'claude-opus-4-7', suggestedModels: ['claude-opus-4-7', 'claude-sonnet-4-6', 'opus', 'sonnet'] },
    orchestrator: { name: 'orchestrator', composite: true, suggestedModels: ['orchestrator'] },
  };
  return {
    registryMod: { PROVIDERS, PROVIDER_INFO, lookupProv: (n) => PROVIDERS[n] || null, parseSlashProviderModel: (s) => ({ provider: null, model: s }) },
    resolveAuthKey: () => '',
    getActiveProvName: () => provName,
    setActiveProvName: (n) => { provName = n; },
    getActiveModel: () => model,
    setActiveModel: (m) => { model = m; },
    getProv: () => prov,
    setProv: (p) => { prov = p; },
  };
}

test('/model offers a switch-provider row', async () => {
  let seen = null;
  const ctx = makeCtx();
  ctx.openPicker = async (opts) => { if (opts.kind === 'model') { seen = opts.items.map((i) => i.id); return 'llama3.1'; } return null; };
  await dispatchSlash('/model', '', ctx);
  assert.ok(seen.includes('__switch_provider__'), 'model picker has a switch-provider row');
});

test('/model switch-provider reaches claude-cli + opus from ollama', async () => {
  const ctx = makeCtx();
  let modelCall = 0;
  ctx.openPicker = async (opts) => {
    if (opts.kind === 'model') {
      modelCall += 1;
      // first model picker (ollama) → choose to switch; second (claude-cli) → opus
      if (modelCall === 1) return '__switch_provider__';
      assert.ok(opts.items.map((i) => i.id).includes('claude-opus-4-7'), 'claude-cli models now listed');
      return 'claude-opus-4-7';
    }
    if (opts.kind === 'provider' || opts.kind === 'provider-family') {
      const ids = opts.items.map((i) => i.id);
      // claude-cli reachable; orchestrator hidden
      if (opts.kind === 'provider') { assert.ok(ids.includes('claude-cli')); return 'claude-cli'; }
      return ids.includes('cli') ? 'cli' : ids[0];
    }
    return null;
  };
  const out = await dispatchSlash('/model', '', ctx);
  assert.equal(ctx.getActiveProvName(), 'claude-cli');
  assert.equal(ctx.getActiveModel(), 'claude-opus-4-7');
  assert.match(out, /claude-cli/);
  assert.match(out, /claude-opus-4-7/);
});
