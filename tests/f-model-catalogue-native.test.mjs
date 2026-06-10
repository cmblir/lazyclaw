// tests/f-model-catalogue-native.test.mjs — live model listing for the
// NATIVE-API providers (anthropic, gemini), mirroring what openai/ollama/
// OpenAI-compat vendors already have. Without this, the picker fell back to
// a stale curated list and newly released models (e.g. claude-fable-5)
// never appeared in model selection.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  supportsLiveFetch,
  fetchAnthropicModels,
  fetchGeminiModels,
  fetchModelsForProvider,
} from '../providers/model_catalogue.mjs';

function jsonResp(obj) {
  return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
}

test('supportsLiveFetch: anthropic and gemini are now live-fetchable', () => {
  assert.equal(supportsLiveFetch({}, 'anthropic'), true);
  assert.equal(supportsLiveFetch({}, 'gemini'), true);
  // unchanged judgements
  assert.equal(supportsLiveFetch({}, 'openai'), true);
  assert.equal(supportsLiveFetch({}, 'ollama'), true);
  assert.equal(supportsLiveFetch({ builtinOpenAICompat: true }, 'groq'), true);
  assert.equal(supportsLiveFetch({}, 'claude-cli'), false, 'keyless CLI has no catalogue endpoint');
  assert.equal(supportsLiveFetch({}, 'mock'), false);
  assert.equal(supportsLiveFetch({}, 'orchestrator'), false);
});

test('fetchAnthropicModels: GET /v1/models with x-api-key + anthropic-version', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return jsonResp({
      data: [
        { type: 'model', id: 'claude-fable-5', display_name: 'Claude Fable 5' },
        { type: 'model', id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
        { type: 'model', id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
      ],
      has_more: false,
    });
  };
  const models = await fetchAnthropicModels({ apiKey: 'sk-ant-test', fetchImpl });
  assert.deepEqual(models, ['claude-fable-5', 'claude-haiku-4-5', 'claude-opus-4-8']);
  assert.match(seen.url, /^https:\/\/api\.anthropic\.com\/v1\/models/);
  assert.equal(seen.init.headers['x-api-key'], 'sk-ant-test');
  assert.equal(seen.init.headers['anthropic-version'], '2023-06-01');
});

test('fetchAnthropicModels: no api key -> clear error, no network call', async () => {
  let called = false;
  await assert.rejects(
    () => fetchAnthropicModels({ apiKey: '', fetchImpl: async () => { called = true; return jsonResp({}); } }),
    /api key/i,
  );
  assert.equal(called, false);
});

test('fetchGeminiModels: strips models/ prefix and keeps only generateContent models', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /generativelanguage\.googleapis\.com\/v1beta\/models/);
    assert.match(url, /key=g-test/);
    return jsonResp({
      models: [
        { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
      ],
    });
  };
  const models = await fetchGeminiModels({ apiKey: 'g-test', fetchImpl });
  assert.deepEqual(models, ['gemini-2.5-flash', 'gemini-2.5-pro']);
});

test('fetchModelsForProvider routes anthropic/gemini to the native fetchers', async () => {
  const fetchImpl = async (url) => {
    if (/api\.anthropic\.com/.test(url)) return jsonResp({ data: [{ id: 'claude-fable-5' }], has_more: false });
    if (/generativelanguage/.test(url)) return jsonResp({ models: [{ name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] }] });
    throw new Error(`unexpected url ${url}`);
  };
  const deps = (providerId) => ({
    cfg: {},
    registryMod: { PROVIDER_INFO: {} },
    resolveAuthKey: () => 'k',
    providerId,
    fetchImpl,
  });
  assert.deepEqual(await fetchModelsForProvider(deps('anthropic')), ['claude-fable-5']);
  assert.deepEqual(await fetchModelsForProvider(deps('gemini')), ['gemini-2.5-pro']);
  // claude-cli still has no catalogue — unchanged error path
  await assert.rejects(() => fetchModelsForProvider(deps('claude-cli')), /does not expose/);
});
