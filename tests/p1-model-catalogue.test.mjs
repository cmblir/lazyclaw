// tests/p1-model-catalogue.test.mjs — P1 restore: shared model-catalogue
// resolution extracted from cli.mjs so the Ink slash dispatcher can offer
// the same live /v1/models fetch the legacy readline picker had.
//
// Pure, dependency-injected — no cli.mjs internals, no network.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  supportsLiveFetch,
  modelCatalogueFor,
} from '../providers/model_catalogue.mjs';

const REGISTRY = {
  PROVIDER_INFO: {
    openai: { name: 'openai' },
    ollama: { name: 'ollama' },
    anthropic: { name: 'anthropic' },
    'claude-cli': { name: 'claude-cli' },
    orchestrator: { name: 'orchestrator', composite: true },
    groq: { name: 'groq', builtinOpenAICompat: true, baseUrl: 'https://api.groq.com/openai/v1' },
    mylab: { name: 'mylab', custom: true, baseUrl: 'https://lab.example/v1' },
  },
};

// ─── supportsLiveFetch ─────────────────────────────────────────────────────

test('supportsLiveFetch is true for openai, ollama, builtin-compat, and any baseUrl', () => {
  assert.equal(supportsLiveFetch(REGISTRY.PROVIDER_INFO.openai, 'openai'), true);
  assert.equal(supportsLiveFetch(REGISTRY.PROVIDER_INFO.ollama, 'ollama'), true);
  assert.equal(supportsLiveFetch(REGISTRY.PROVIDER_INFO.groq, 'groq'), true);
  assert.equal(supportsLiveFetch(REGISTRY.PROVIDER_INFO.mylab, 'mylab'), true);
});

test('supportsLiveFetch: every real provider is live; only mock/orchestrator are not', () => {
  // anthropic + gemini list via their native endpoints; the keyless CLI
  // providers borrow the credential their vendor accepts (anthropic key /
  // Claude Code OAuth token; gemini key; openai key) — so every provider
  // that has models to list can list them.
  assert.equal(supportsLiveFetch(REGISTRY.PROVIDER_INFO.anthropic, 'anthropic'), true);
  assert.equal(supportsLiveFetch(REGISTRY.PROVIDER_INFO.gemini, 'gemini'), true);
  assert.equal(supportsLiveFetch(REGISTRY.PROVIDER_INFO['claude-cli'], 'claude-cli'), true);
  // the meta-provider has no catalogue (its "model" is the pipeline).
  assert.equal(supportsLiveFetch(REGISTRY.PROVIDER_INFO.orchestrator, 'orchestrator'), false);
});

// ─── modelCatalogueFor ─────────────────────────────────────────────────────

function deps(providerId, cfg = {}) {
  return {
    cfg,
    registryMod: REGISTRY,
    resolveAuthKey: (id) => `key-for-${id}`,
    providerId,
  };
}

test('modelCatalogueFor resolves the OpenAI endpoint + resolved key', () => {
  const c = modelCatalogueFor(deps('openai'));
  assert.deepEqual(c, { baseUrl: 'https://api.openai.com/v1', apiKey: 'key-for-openai' });
});

test('modelCatalogueFor resolves the Ollama endpoint (keyless, honors OLLAMA_HOST)', () => {
  const prev = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = 'http://box:9999/';
  try {
    const c = modelCatalogueFor(deps('ollama'));
    assert.deepEqual(c, { baseUrl: 'http://box:9999/v1', apiKey: '' });
  } finally {
    if (prev === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = prev;
  }
});

test('modelCatalogueFor resolves a builtin OpenAI-compat vendor via resolveAuthKey', () => {
  const c = modelCatalogueFor(deps('groq'));
  assert.deepEqual(c, { baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'key-for-groq' });
});

test('modelCatalogueFor resolves a custom endpoint from cfg.customProviders', () => {
  const cfg = { customProviders: [{ name: 'mylab', apiKey: 'lab-secret' }] };
  const c = modelCatalogueFor(deps('mylab', cfg));
  assert.deepEqual(c, { baseUrl: 'https://lab.example/v1', apiKey: 'lab-secret' });
});

test('modelCatalogueFor returns null for providers with no /v1/models catalogue', () => {
  assert.equal(modelCatalogueFor(deps('anthropic')), null);
  assert.equal(modelCatalogueFor(deps('claude-cli')), null);
  assert.equal(modelCatalogueFor(deps('orchestrator')), null);
});
