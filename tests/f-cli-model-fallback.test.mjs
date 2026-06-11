// tests/f-cli-model-fallback.test.mjs — a ChatGPT-plan codex / Google-account
// gemini login has no platform API key, so /v1/models can't be listed. Instead
// of throwing "fetch failed", the model fetch falls back to the model the local
// CLI config is set to use (~/.codex/config.toml, ~/.gemini/settings.json).

import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchModelsForProvider, _codexConfigModels, _geminiConfigModels } from '../providers/model_catalogue.mjs';

const enoent = () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };

test('_codexConfigModels: parses the model line from config.toml', () => {
  const read = (p) => p.endsWith('/.codex/config.toml')
    ? 'model = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n'
    : enoent();
  assert.deepEqual(_codexConfigModels({ home: '/h', readFileSync: read }), ['gpt-5.5']);
  assert.deepEqual(_codexConfigModels({ home: '/h', readFileSync: enoent }), []);
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
