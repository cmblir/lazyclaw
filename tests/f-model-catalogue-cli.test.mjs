// tests/f-model-catalogue-cli.test.mjs — live model listing for the keyless
// CLI providers. They have no key of their own, so each borrows the
// credential its vendor accepts, best-effort with honest errors:
//   claude-cli → anthropic key (x-api-key) OR a Claude Code OAuth token
//                (Authorization: Bearer + anthropic-beta: oauth-2025-04-20)
//   gemini-cli → gemini key (GEMINI_API_KEY / GOOGLE_API_KEY)
//   codex-cli  → openai key (env / profile / ~/.codex/auth.json when it
//                stores a plain API key)

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  supportsLiveFetch,
  fetchAnthropicModels,
  fetchModelsForProvider,
  _claudeCodeOAuthToken,
  _codexStoredApiKey,
} from '../providers/model_catalogue.mjs';

function jsonResp(obj) {
  return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
}
const ANTHROPIC_LIST = { data: [{ id: 'claude-fable-5' }, { id: 'claude-opus-4-8' }], has_more: false };

test('supportsLiveFetch: all three CLI providers are live-fetchable now', () => {
  for (const id of ['claude-cli', 'gemini-cli', 'codex-cli']) {
    assert.equal(supportsLiveFetch({}, id), true, id);
  }
  assert.equal(supportsLiveFetch({}, 'mock'), false);
  assert.equal(supportsLiveFetch({}, 'orchestrator'), false);
});

test('fetchAnthropicModels: oauthToken uses Bearer + the oauth beta header', async () => {
  let seen = null;
  const models = await fetchAnthropicModels({
    oauthToken: 'sk-ant-oat01-test',
    fetchImpl: async (url, init) => { seen = { url, init }; return jsonResp(ANTHROPIC_LIST); },
  });
  assert.deepEqual(models, ['claude-fable-5', 'claude-opus-4-8']);
  assert.equal(seen.init.headers['authorization'], 'Bearer sk-ant-oat01-test');
  assert.equal(seen.init.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal('x-api-key' in seen.init.headers, false);
});

test('claude-cli routing: api key wins; else env OAuth token; else honest error', async () => {
  const fetchImpl = async (url, init) => jsonResp(ANTHROPIC_LIST);
  const base = { cfg: {}, registryMod: { PROVIDER_INFO: {} }, providerId: 'claude-cli', fetchImpl };

  // (a) anthropic auth-profile key present → used as x-api-key
  let headers = null;
  await fetchModelsForProvider({
    ...base,
    resolveAuthKey: (id) => (id === 'anthropic' ? 'sk-ant-key' : ''),
    fetchImpl: async (u, init) => { headers = init.headers; return jsonResp(ANTHROPIC_LIST); },
  });
  assert.equal(headers['x-api-key'], 'sk-ant-key');

  // (b) no key, CLAUDE_CODE_OAUTH_TOKEN set → Bearer path
  const prev = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-x';
  try {
    await fetchModelsForProvider({
      ...base,
      resolveAuthKey: () => '',
      fetchImpl: async (u, init) => { headers = init.headers; return jsonResp(ANTHROPIC_LIST); },
    });
    assert.equal(headers['authorization'], 'Bearer sk-ant-oat01-x');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = prev;
  }

  // (c) nothing at all → clear, actionable error
  const prevEnv = { t: process.env.CLAUDE_CODE_OAUTH_TOKEN, k: process.env.ANTHROPIC_API_KEY };
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN; delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(
      () => fetchModelsForProvider({ ...base, resolveAuthKey: () => '', _credReader: () => null }),
      /ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/,
    );
  } finally {
    if (prevEnv.t !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = prevEnv.t;
    if (prevEnv.k !== undefined) process.env.ANTHROPIC_API_KEY = prevEnv.k;
  }
});

test('_claudeCodeOAuthToken: reads the Linux credential store shapes', () => {
  const files = {
    '/h/.claude/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'tok-a' } }),
  };
  const read = (p) => { if (files[p] === undefined) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files[p]; };
  assert.equal(_claudeCodeOAuthToken({ home: '/h', readFileSync: read }), 'tok-a');
  // flat accessToken shape also accepted
  files['/h/.claude/.credentials.json'] = JSON.stringify({ accessToken: 'tok-b' });
  assert.equal(_claudeCodeOAuthToken({ home: '/h', readFileSync: read }), 'tok-b');
  // nothing on disk (macOS keychain) → null, never a throw
  assert.equal(_claudeCodeOAuthToken({ home: '/nope', readFileSync: read }), null);
});

test('_codexStoredApiKey: plain-string key accepted, OAuth-only auth.json ignored', () => {
  const mk = (obj) => (p) => {
    if (!p.endsWith('/.codex/auth.json')) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return JSON.stringify(obj);
  };
  assert.equal(_codexStoredApiKey({ home: '/h', readFileSync: mk({ OPENAI_API_KEY: 'sk-live' }) }), 'sk-live');
  // ChatGPT-OAuth login stores an empty object + tokens — not a platform key
  assert.equal(_codexStoredApiKey({ home: '/h', readFileSync: mk({ OPENAI_API_KEY: {}, tokens: {} }) }), null);
  assert.equal(_codexStoredApiKey({ home: '/h', readFileSync: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } }), null);
});

test('gemini-cli and codex-cli route to their vendor list endpoints', async () => {
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(url);
    if (/generativelanguage/.test(url)) return jsonResp({ models: [{ name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] }] });
    return jsonResp({ data: [{ id: 'gpt-5-codex' }, { id: 'gpt-5' }] });
  };
  const deps = (providerId, keyFor) => ({
    cfg: {}, registryMod: { PROVIDER_INFO: {} }, providerId, fetchImpl,
    resolveAuthKey: (id) => (id === keyFor ? 'k' : ''),
    _credReader: () => null,
  });
  assert.deepEqual(await fetchModelsForProvider(deps('gemini-cli', 'gemini')), ['gemini-2.5-pro']);
  assert.deepEqual(await fetchModelsForProvider(deps('codex-cli', 'openai')), ['gpt-5', 'gpt-5-codex']);
  assert.ok(urls.some((u) => /api\.openai\.com\/v1\/models/.test(u)), 'codex-cli lists via the OpenAI catalogue');
});
