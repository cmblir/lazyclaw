// tests/p1-model-dispatch.test.mjs — P1 restore: the Ink /model slash regains
// the depth the legacy readline picker had and that v5.4 dropped:
//   · live-fetch the provider's /v1/models list,
//   · type a custom/unlisted model id,
//   · escape a composite (orchestrator) active provider that has no real
//     models by picking a provider first, then its model.
//
// All exercised through dispatchSlash('/model', ...) with a mocked
// ctx.openPicker, so no Ink runtime is needed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { dispatchSlash } from '../tui/slash_dispatcher.mjs';

function makeCtx(overrides = {}) {
  let provName = overrides.provName || 'ollama';
  let model = overrides.model || null;
  let prov = { id: provName };

  const PROVIDERS = {
    ollama: { id: 'ollama' },
    anthropic: { id: 'anthropic' },
    mylab: { id: 'mylab' },
    orchestrator: { id: 'orchestrator' },
    mock: { id: 'mock' },
  };
  const PROVIDER_INFO = {
    ollama: { name: 'ollama', defaultModel: 'llama3.1', suggestedModels: ['llama3.1', 'llama3.3', 'qwen2.5-coder'] },
    anthropic: { name: 'anthropic', defaultModel: 'claude-opus-4-7', suggestedModels: ['claude-opus-4-7', 'claude-sonnet-4-6'] },
    mylab: { name: 'mylab', custom: true, baseUrl: 'https://lab.example/v1', suggestedModels: [] },
    orchestrator: { name: 'orchestrator', composite: true, defaultModel: 'orchestrator', suggestedModels: ['orchestrator'] },
    mock: { name: 'mock', suggestedModels: [] },
  };
  const registry = {
    PROVIDERS,
    PROVIDER_INFO,
    lookupProv: (name) => PROVIDERS[name] || null,
    parseSlashProviderModel: (s) => {
      const i = s.indexOf('/');
      if (i < 0) return { provider: null, model: s };
      return { provider: s.slice(0, i), model: s.slice(i + 1) };
    },
  };
  return {
    cfg: {},
    registryMod: registry,
    resolveAuthKey: () => '',
    getActiveProvName: () => provName,
    setActiveProvName: (n) => { provName = n; },
    getActiveModel: () => model,
    setActiveModel: (m) => { model = m; },
    getProv: () => prov,
    setProv: (p) => { prov = p; },
    ...overrides,
  };
}

// ─── normal pick + sentinel rows ───────────────────────────────────────────

test('/model no-arg lists models with live-fetch + custom-id sentinel rows', async () => {
  let seenItems = null;
  const ctx = makeCtx({
    openPicker: async (opts) => { seenItems = opts.items; return 'llama3.3'; },
  });
  const out = await dispatchSlash('/model', '', ctx);
  assert.match(out, /model → llama3\.3/);
  assert.equal(ctx.getActiveModel(), 'llama3.3');
  const ids = seenItems.map((i) => i.id);
  assert.ok(ids.includes('llama3.3'), 'suggested model present');
  assert.ok(ids.includes('__fetch_models__'), 'live-fetch row present (ollama supports it)');
  assert.ok(ids.includes('__custom_model__'), 'custom-id row present');
  const custom = seenItems.find((i) => i.id === '__custom_model__');
  assert.equal(custom.freeText, true);
  assert.equal(custom.pinned, true);
});

test('/model no-arg for a non-fetchable provider omits the fetch row but keeps custom', async () => {
  let seenItems = null;
  const ctx = makeCtx({
    provName: 'orchestrator',
    openPicker: async (opts) => { seenItems = opts.items; return 'orchestrator'; },
  });
  await dispatchSlash('/model', '', ctx);
  const ids = seenItems.map((i) => i.id);
  assert.ok(!ids.includes('__fetch_models__'), 'orchestrator (meta-provider) has no catalogue endpoint');
  assert.ok(ids.includes('__custom_model__'));
});

test('/model no-arg for anthropic now INCLUDES the live fetch row (native /v1/models)', async () => {
  let seenItems = null;
  const ctx = makeCtx({
    provName: 'anthropic',
    openPicker: async (opts) => { seenItems = opts.items; return 'claude-fable-5'; },
  });
  await dispatchSlash('/model', '', ctx);
  const ids = seenItems.map((i) => i.id);
  assert.ok(ids.includes('__fetch_models__'), 'anthropic gained a live model list');
});

// ─── custom-type-in ────────────────────────────────────────────────────────

test('/model no-arg custom row uses the typed filter buffer as the model id', async () => {
  const ctx = makeCtx({
    provName: 'anthropic',
    openPicker: async () => ({ id: '__custom_model__', query: 'claude-future-99' }),
  });
  const out = await dispatchSlash('/model', '', ctx);
  assert.match(out, /model → claude-future-99/);
  assert.equal(ctx.getActiveModel(), 'claude-future-99');
});

// ─── live-fetch loop ───────────────────────────────────────────────────────

test('/model no-arg live-fetch row merges fetched models then lets you pick one', async () => {
  let call = 0;
  const itemsByCall = [];
  const ctx = makeCtx({
    provName: 'mylab',
    fetchModels: async () => ['lab-large', 'lab-small'],
    openPicker: async (opts) => {
      itemsByCall.push(opts.items.map((i) => i.id));
      call += 1;
      if (call === 1) return '__fetch_models__';
      return 'lab-large';
    },
  });
  const out = await dispatchSlash('/model', '', ctx);
  assert.match(out, /model → lab-large/);
  assert.equal(ctx.getActiveModel(), 'lab-large');
  // Second picker render must include the fetched models.
  assert.ok(itemsByCall[1].includes('lab-large'));
  assert.ok(itemsByCall[1].includes('lab-small'));
});

// ─── orchestrator dead-end escape (the reported bug) ───────────────────────

test('/model no-arg on a composite provider picks a provider first, then a model', async () => {
  const kinds = [];
  const ctx = makeCtx({
    provName: 'orchestrator',
    openPicker: async (opts) => {
      kinds.push(opts.kind);
      if (opts.kind === 'provider') {
        // orchestrator + mock must be hidden from the provider list
        const ids = opts.items.map((i) => i.id);
        assert.ok(!ids.includes('orchestrator'), 'composite hidden');
        assert.ok(!ids.includes('mock'), 'mock hidden');
        assert.ok(ids.includes('ollama'));
        return 'ollama';
      }
      return 'llama3.3';
    },
  });
  const out = await dispatchSlash('/model', '', ctx);
  assert.deepEqual(kinds, ['provider', 'model']);
  assert.equal(ctx.getActiveProvName(), 'ollama');
  assert.equal(ctx.getActiveModel(), 'llama3.3');
  assert.match(out, /provider → ollama/);
  assert.match(out, /model → llama3\.3/);
});

test('/model composite redirect keeps the provider switch if the model pick is cancelled', async () => {
  const ctx = makeCtx({
    provName: 'orchestrator',
    openPicker: async (opts) => (opts.kind === 'provider' ? 'ollama' : null),
  });
  const out = await dispatchSlash('/model', '', ctx);
  assert.equal(ctx.getActiveProvName(), 'ollama');
  assert.match(out, /model unchanged/);
});

// ─── cancel ────────────────────────────────────────────────────────────────

test('/model no-arg cancelled picker returns "cancelled" with no mutation', async () => {
  const ctx = makeCtx({ provName: 'ollama', model: 'llama3.1', openPicker: async () => null });
  const out = await dispatchSlash('/model', '', ctx);
  assert.match(out, /cancelled/);
  assert.equal(ctx.getActiveModel(), 'llama3.1');
});

// ─── arg path still works ──────────────────────────────────────────────────

test('/model <name> arg path is unchanged', async () => {
  const ctx = makeCtx({ provName: 'ollama' });
  const out = await dispatchSlash('/model', 'qwen3.5-instruct:9b', ctx);
  assert.match(out, /model → qwen3\.5-instruct:9b/);
  assert.equal(ctx.getActiveModel(), 'qwen3.5-instruct:9b');
});
