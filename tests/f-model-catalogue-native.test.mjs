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
  assert.equal(supportsLiveFetch({}, 'claude-cli'), true, 'borrows an anthropic key / Claude Code OAuth token');
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
  // claude-cli now borrows the anthropic credential and lists too
  assert.deepEqual(await fetchModelsForProvider(deps('claude-cli')), ['claude-fable-5']);
  // truly catalogue-less providers keep the honest error
  await assert.rejects(() => fetchModelsForProvider(deps('orchestrator')), /does not expose/);
});

// ── hanging endpoints ───────────────────────────────────────────────
// These calls had no signal, so a non-responding endpoint (not an HTTP error —
// an actual dead connection) left them pending until the OS gave up on the TCP
// socket, holding a model-cache refresh tick's promise unresolved for minutes.
//
// Split into two assertions rather than waiting out the real timeout: that an
// abortable signal is handed to fetch at all, and that an abort is translated
// into a message naming the provider. A test that slept 10s would be the same
// coverage at 10s a run.

test('both live fetchers pass an abortable signal to fetch', async () => {
  const seen = [];
  const capture = async (url, init) => {
    seen.push(init?.signal);
    return { ok: true, json: async () => ({ data: [], models: [] }) };
  };
  await fetchAnthropicModels({ apiKey: 'k', fetchImpl: capture });
  await fetchGeminiModels({ apiKey: 'k', fetchImpl: capture });
  assert.equal(seen.length, 2);
  for (const sig of seen) {
    assert.ok(sig, 'a fetch with no signal cannot be interrupted');
    assert.equal(typeof sig.addEventListener, 'function', 'must be an AbortSignal');
    assert.equal(sig.aborted, false, 'and not already aborted');
  }
});

test('an aborted fetch reports which provider timed out, not a bare DOMException', async () => {
  // What AbortSignal.timeout actually throws: name TimeoutError, and a message
  // that names neither the provider nor the duration.
  const aborts = async () => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    throw e;
  };
  await assert.rejects(
    () => fetchAnthropicModels({ apiKey: 'k', fetchImpl: aborts }),
    /anthropic \/v1\/models timed out after \d+ms/);
  await assert.rejects(
    () => fetchGeminiModels({ apiKey: 'k', fetchImpl: aborts }),
    /gemini models list timed out after \d+ms/);
});

test('a non-timeout fetch failure is not relabelled as a timeout', async () => {
  const boom = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(() => fetchAnthropicModels({ apiKey: 'k', fetchImpl: boom }), /ECONNREFUSED/);
});
