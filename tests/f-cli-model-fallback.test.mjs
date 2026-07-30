// tests/f-cli-model-fallback.test.mjs — a ChatGPT-plan codex / Google-account
// gemini login has no platform API key, so /v1/models can't be listed. Instead
// of throwing "fetch failed", the model fetch falls back to the model the local
// CLI config is set to use (~/.codex/config.toml, ~/.gemini/settings.json).

import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchModelsForProvider, _codexConfigModels, _codexCachedModels, _geminiConfigModels } from '../providers/model_catalogue.mjs';

const enoent = () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };

test('_codexConfigModels: parses the model line from config.toml', () => {
  const read = (p) => p.endsWith('/.codex/config.toml')
    ? 'model = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n'
    : enoent();
  assert.deepEqual(_codexConfigModels({ home: '/h', readFileSync: read }), ['gpt-5.5']);
  assert.deepEqual(_codexConfigModels({ home: '/h', readFileSync: enoent }), []);
});

// The codex CLI caches the models the account can actually use in
// ~/.codex/models_cache.json, which is far more than the single model pinned in
// config.toml. Before this, a ChatGPT-plan login saw exactly one model in the
// picker (whatever config.toml said) even though the cache listed seven.
test('_codexCachedModels: lists visible cached models in priority order', () => {
  const cache = JSON.stringify({
    fetched_at: '2026-07-30T01:13:30Z',
    models: [
      { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', priority: 16 },
      { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', priority: 1 },
      { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', priority: 43 },
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 7 },
    ],
  });
  const read = (p) => p.endsWith('/.codex/models_cache.json') ? cache : enoent();
  // priority ascending, and the `hide` entry is excluded.
  assert.deepEqual(
    _codexCachedModels({ home: '/h', readFileSync: read }),
    ['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4'],
  );
});

test('_codexCachedModels: a missing or malformed cache yields [] rather than throwing', () => {
  assert.deepEqual(_codexCachedModels({ home: '/h', readFileSync: enoent }), []);
  assert.deepEqual(_codexCachedModels({ home: '/h', readFileSync: () => 'not json' }), []);
  assert.deepEqual(_codexCachedModels({ home: '/h', readFileSync: () => '{"models":"nope"}' }), []);
  assert.deepEqual(_codexCachedModels({ home: '/h', readFileSync: () => '{}' }), []);
  // entries without a usable slug are skipped, not emitted as undefined
  assert.deepEqual(
    _codexCachedModels({ home: '/h', readFileSync: () => '{"models":[{"visibility":"list"},{"slug":"ok","visibility":"list"}]}' }),
    ['ok'],
  );
});

test('codex-cli with no API key prefers the cache and falls back to config.toml', async () => {
  const withCache = await fetchModelsForProvider({
    cfg: {}, registryMod: { PROVIDER_INFO: {} }, providerId: 'codex-cli',
    resolveAuthKey: () => '', _credReader: () => null,
    _codexCachedModels: () => ['gpt-5.6-sol', 'gpt-5.5'],
    _codexConfigModels: () => ['gpt-5.5'],
  });
  assert.deepEqual(withCache, ['gpt-5.6-sol', 'gpt-5.5']);

  const noCache = await fetchModelsForProvider({
    cfg: {}, registryMod: { PROVIDER_INFO: {} }, providerId: 'codex-cli',
    resolveAuthKey: () => '', _credReader: () => null,
    _codexCachedModels: () => [],
    _codexConfigModels: () => ['gpt-5.5'],
  });
  assert.deepEqual(noCache, ['gpt-5.5'], 'an empty cache must not shadow the config.toml fallback');
});

test('_geminiConfigModels: reads a pinned model from settings.json (else [])', () => {
  const read = (p) => p.endsWith('/.gemini/settings.json') ? JSON.stringify({ model: 'gemini-2.5-pro' }) : enoent();
  assert.deepEqual(_geminiConfigModels({ home: '/h', readFileSync: read }), ['gemini-2.5-pro']);
  assert.deepEqual(_geminiConfigModels({ home: '/h', readFileSync: () => '{}' }), []);
});

test('codex-cli fetch with no API key returns the configured model, not a throw', async () => {
  const out = await fetchModelsForProvider({
    cfg: {}, registryMod: { PROVIDER_INFO: {} }, providerId: 'codex-cli',
    resolveAuthKey: () => '',
    _credReader: () => null,                 // no auth.json key
    _codexCachedModels: () => [],            // codex cache seam: absent here
    _codexConfigModels: () => ['gpt-5.5'],   // local config seam
  });
  assert.deepEqual(out, ['gpt-5.5']);
});

test('gemini-cli fetch with no API key returns the local config model (or [])', async () => {
  const out = await fetchModelsForProvider({
    cfg: {}, registryMod: { PROVIDER_INFO: {} }, providerId: 'gemini-cli',
    resolveAuthKey: () => '',
    _geminiConfigModels: () => [],
  });
  assert.deepEqual(out, []);
});
