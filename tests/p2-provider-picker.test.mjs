// tests/p2-provider-picker.test.mjs — P2 restore: the Ink /provider picker
// regains the legacy family drill-in (API key / CLI-Local / Mock) with
// per-row tags, and never exposes the opt-in orchestrator. The v5.4 port had
// shipped a flat alphabetical list that even listed orchestrator.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bucketProviders,
  providerFamilies,
  providerTag,
} from '../tui/provider_families.mjs';
import { dispatchSlash } from '../tui/slash_dispatcher.mjs';

const REGISTRY = {
  PROVIDERS: { anthropic: {}, openai: {}, 'claude-cli': {}, ollama: {}, orchestrator: {}, mock: {}, mylab: {} },
  PROVIDER_INFO: {
    anthropic: { requiresApiKey: true },
    openai: { requiresApiKey: true },
    'claude-cli': { requiresApiKey: false },
    ollama: { requiresApiKey: false },
    orchestrator: { composite: true },
    mock: {},
    mylab: { custom: true, requiresApiKey: true, baseUrl: 'https://lab/v1' },
  },
};

// ─── pure bucketing ────────────────────────────────────────────────────────

test('bucketProviders splits api / cli / meta / mock; orchestrator is meta-only', () => {
  const b = bucketProviders(REGISTRY);
  assert.deepEqual(b.api.sort(), ['anthropic', 'mylab', 'openai']);
  assert.deepEqual(b.cli.sort(), ['claude-cli', 'ollama']);
  assert.deepEqual(b.mock, ['mock']);
  // orchestrator is pickable again (its own Multi-agent family) but never
  // lands in the default-facing api/cli buckets.
  assert.deepEqual(b.meta, ['orchestrator']);
  assert.ok(!b.api.includes('orchestrator') && !b.cli.includes('orchestrator'));
});

test('providerFamilies carries labels, plain tags, and members', () => {
  const f = providerFamilies(REGISTRY);
  assert.equal(f.api.tag, 'needs key');
  assert.equal(f.cli.tag, 'no key');
  assert.equal(f.meta.tag, 'meta');
  assert.equal(f.mock.tag, 'test');
  assert.ok(f.api.members.includes('openai'));
  assert.ok(f.meta.members.includes('orchestrator'));
});

test('providerTag reflects custom / api-key / keyless', () => {
  assert.equal(providerTag({ custom: true }), 'custom');
  assert.equal(providerTag({ requiresApiKey: true }), 'api key');
  assert.equal(providerTag({ requiresApiKey: false }), 'no key');
});

// ─── dispatcher 2-stage picker ─────────────────────────────────────────────

function makeProviderCtx(overrides = {}) {
  let provName = 'ollama';
  let prov = { id: provName };
  return {
    registryMod: REGISTRY,
    getActiveProvName: () => provName,
    setActiveProvName: (n) => { provName = n; },
    getActiveModel: () => null,
    setProv: (p) => { prov = p; },
    getProv: () => prov,
    ...overrides,
  };
}

test('/provider no-arg drills family -> member and never lists orchestrator', async () => {
  const kinds = [];
  const ctx = makeProviderCtx({
    openPicker: async (opts) => {
      kinds.push(opts.kind);
      const ids = opts.items.map((i) => i.id);
      assert.ok(!ids.includes('orchestrator'), 'orchestrator hidden in every step');
      if (opts.kind === 'provider-family') {
        assert.ok(ids.includes('api') && ids.includes('cli'));
        return 'api';
      }
      // member step for the api family
      assert.ok(ids.includes('openai'));
      return 'openai';
    },
  });
  const out = await dispatchSlash('/provider', '', ctx);
  assert.deepEqual(kinds, ['provider-family', 'provider']);
  assert.equal(ctx.getActiveProvName(), 'openai');
  assert.match(out, /provider → openai/);
});

test('/provider member rows carry tags', async () => {
  let memberItems = null;
  const ctx = makeProviderCtx({
    openPicker: async (opts) => {
      if (opts.kind === 'provider-family') return 'cli';
      memberItems = opts.items;
      return 'claude-cli';
    },
  });
  await dispatchSlash('/provider', '', ctx);
  const claude = memberItems.find((i) => i.id === 'claude-cli');
  assert.equal(claude.tag, 'no key');
});

test('/provider cancel at family step returns cancelled, no mutation', async () => {
  const ctx = makeProviderCtx({ openPicker: async () => null });
  const out = await dispatchSlash('/provider', '', ctx);
  assert.match(out, /cancelled/);
  assert.equal(ctx.getActiveProvName(), 'ollama');
});

test('/provider arg path unchanged', async () => {
  const ctx = makeProviderCtx();
  const out = await dispatchSlash('/provider', 'anthropic', ctx);
  assert.match(out, /provider → anthropic/);
  assert.equal(ctx.getActiveProvName(), 'anthropic');
});
