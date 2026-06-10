// tests/f-cli-providers-registered.test.mjs — the keyless CLI providers
// (gemini-cli, codex-cli) were fully implemented in providers/ but never
// registered, so they were invisible in /provider and the setup wizard.
// This pins them (and the orchestrator's Multi-agent family) into the
// registry + picker buckets.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureRegistry, getRegistry } from '../lib/registry_boot.mjs';
import { bucketProviders, providerFamilies } from '../tui/provider_families.mjs';

test('gemini-cli and codex-cli are registered providers with metadata', async () => {
  await ensureRegistry();
  const r = getRegistry();
  for (const id of ['gemini-cli', 'codex-cli']) {
    assert.ok(r.PROVIDERS[id], `${id} in PROVIDERS`);
    assert.equal(typeof r.PROVIDERS[id].sendMessage, 'function', `${id} implements sendMessage`);
    const info = r.PROVIDER_INFO[id];
    assert.ok(info, `${id} in PROVIDER_INFO`);
    assert.equal(info.requiresApiKey, false, `${id} is keyless`);
    assert.ok(Array.isArray(info.suggestedModels) && info.suggestedModels.length > 0);
  }
  assert.equal(r.PROVIDER_INFO['gemini-cli'].defaultModel, 'gemini-2.5-pro');
  assert.equal(r.PROVIDER_INFO['codex-cli'].defaultModel, 'gpt-5-codex');
});

test('picker buckets: CLI family now offers all four keyless providers', async () => {
  await ensureRegistry();
  const b = bucketProviders(getRegistry());
  for (const id of ['claude-cli', 'gemini-cli', 'codex-cli', 'ollama']) {
    assert.ok(b.cli.includes(id), `${id} in the CLI/Local family`);
  }
  assert.deepEqual(b.meta, ['orchestrator'], 'orchestrator pickable via the Multi-agent family');
  const f = providerFamilies(getRegistry());
  assert.ok(f.meta.members.includes('orchestrator'));
});
