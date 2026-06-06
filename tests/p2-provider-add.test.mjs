// tests/p2-provider-add.test.mjs — P2 restore: registering a custom
// OpenAI-compatible endpoint from inside the Ink /provider flow, both via the
// arg form (/provider add <name> <url> [key]) and the interactive
// "+ add a custom endpoint" row in the API-key family.

import test from 'node:test';
import assert from 'node:assert/strict';

import { dispatchSlash } from '../tui/slash_dispatcher.mjs';

function makeCtx({ models = ['m1', 'm2'] } = {}) {
  let store = {};
  let provName = 'ollama';
  let prov = { id: provName };
  const PROVIDERS = { anthropic: {}, ollama: {}, 'claude-cli': {}, orchestrator: {}, mock: {} };
  const PROVIDER_INFO = {
    anthropic: { requiresApiKey: true },
    ollama: { requiresApiKey: false },
    'claude-cli': { requiresApiKey: false },
    orchestrator: { composite: true },
  };
  const registry = {
    PROVIDERS,
    PROVIDER_INFO,
    lookupProv: (n) => PROVIDERS[n] || null,
    validateCustomProviderName: (raw) => {
      const s = String(raw || '').trim().toLowerCase();
      if (!/^[a-z0-9_-]+$/.test(s)) throw new Error(`invalid provider name: "${raw}"`);
      return s;
    },
    isBuiltinOpenAICompatName: () => false,
    registerCustomProviders: (cfg) => {
      for (const p of cfg.customProviders || []) {
        PROVIDERS[p.name] = { id: p.name };
        PROVIDER_INFO[p.name] = { requiresApiKey: !!p.apiKey, custom: true, baseUrl: p.baseUrl };
      }
    },
    fetchOpenAICompatModels: async () => models,
  };
  return {
    registryMod: registry,
    readConfig: () => JSON.parse(JSON.stringify(store)),
    writeConfig: (cfg) => { store = JSON.parse(JSON.stringify(cfg)); },
    getActiveProvName: () => provName,
    setActiveProvName: (n) => { provName = n; },
    getActiveModel: () => null,
    setProv: (p) => { prov = p; },
    getProv: () => prov,
    _peek: () => store,
  };
}

test('/provider add <name> <url> [key] registers + activates a custom endpoint', async () => {
  const ctx = makeCtx({ models: ['lab-a', 'lab-b'] });
  const out = await dispatchSlash('/provider', 'add nim https://integrate.api.nvidia.com/v1 nvapi-x', ctx);
  assert.match(out, /saved/);
  assert.match(out, /nim/);
  assert.equal(ctx.getActiveProvName(), 'nim');
  const saved = ctx._peek().customProviders.find((p) => p.name === 'nim');
  assert.equal(saved.baseUrl, 'https://integrate.api.nvidia.com/v1');
  assert.equal(saved.apiKey, 'nvapi-x');
});

test('/provider add with missing fields shows usage', async () => {
  const ctx = makeCtx();
  const out = await dispatchSlash('/provider', 'add nim', ctx);
  assert.match(out, /usage: \/provider add/);
  assert.equal(ctx.getActiveProvName(), 'ollama');
});

test('interactive "+ add custom endpoint" row collects fields and registers', async () => {
  const ctx = makeCtx({ models: ['x'] });
  const textAnswers = ['mylab', 'https://lab.example/v1', 'lab-key'];
  let textCall = 0;
  ctx.openPicker = async (opts) => {
    if (opts.kind === 'provider-family') return 'api';
    if (opts.kind === 'provider') {
      // the API-key family must offer the add-custom row
      const ids = opts.items.map((i) => i.id);
      assert.ok(ids.includes('__add_custom__'), 'add-custom row present');
      return '__add_custom__';
    }
    if (opts.kind === 'text') {
      return { id: '__text__', query: textAnswers[textCall++] };
    }
    return null;
  };
  const out = await dispatchSlash('/provider', '', ctx);
  assert.match(out, /mylab/);
  assert.equal(ctx.getActiveProvName(), 'mylab');
  const saved = ctx._peek().customProviders.find((p) => p.name === 'mylab');
  assert.equal(saved.baseUrl, 'https://lab.example/v1');
});
