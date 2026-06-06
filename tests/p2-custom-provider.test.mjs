// tests/p2-custom-provider.test.mjs — P2 restore: registering a custom
// OpenAI-compatible endpoint (NIM / OpenRouter / Together / Groq / vLLM /
// LM Studio) was reachable from the legacy readline provider wizard but the
// v5.4 Ink port dropped it entirely. The persistence + live probe core is
// extracted here, dependency-injected, so both paths share it and it tests
// without disk or network.

import test from 'node:test';
import assert from 'node:assert/strict';

import { addCustomProvider, validateCustomBaseUrl } from '../providers/custom_provider.mjs';

function makeRegistry({ models = ['m-a', 'm-b'], fetchThrows = null } = {}) {
  const calls = { register: 0 };
  return {
    calls,
    validateCustomProviderName: (raw) => {
      const s = String(raw || '').trim().toLowerCase();
      if (!/^[a-z0-9_-]+$/.test(s)) throw new Error(`invalid provider name: "${raw}"`);
      return s;
    },
    isBuiltinOpenAICompatName: (n) => n === 'groq',
    registerCustomProviders: () => { calls.register += 1; },
    fetchOpenAICompatModels: async () => {
      if (fetchThrows) throw new Error(fetchThrows);
      return models;
    },
  };
}

function makeConfigIO(initial = {}) {
  let store = JSON.parse(JSON.stringify(initial));
  return {
    readConfig: () => JSON.parse(JSON.stringify(store)),
    writeConfig: (cfg) => { store = JSON.parse(JSON.stringify(cfg)); },
    peek: () => store,
  };
}

// ─── validateCustomBaseUrl ─────────────────────────────────────────────────

test('validateCustomBaseUrl strips trailing slashes and requires http(s)', () => {
  assert.equal(validateCustomBaseUrl('https://x.example/v1//'), 'https://x.example/v1');
  assert.throws(() => validateCustomBaseUrl(''), /required/);
  assert.throws(() => validateCustomBaseUrl('ftp://x/v1'), /http/);
});

// ─── addCustomProvider ─────────────────────────────────────────────────────

test('addCustomProvider persists the entry, registers, and probes /v1/models', async () => {
  const reg = makeRegistry({ models: ['big', 'small'] });
  const io = makeConfigIO();
  const r = await addCustomProvider({
    registry: reg, readConfig: io.readConfig, writeConfig: io.writeConfig,
    name: 'NIM', baseUrl: 'https://integrate.api.nvidia.com/v1/', apiKey: 'nvapi-x',
  });
  assert.equal(r.name, 'nim');
  assert.equal(r.baseUrl, 'https://integrate.api.nvidia.com/v1');
  assert.equal(r.probe.ok, true);
  assert.equal(r.probe.count, 2);
  const saved = io.peek().customProviders.find((p) => p.name === 'nim');
  assert.equal(saved.baseUrl, 'https://integrate.api.nvidia.com/v1');
  assert.equal(saved.apiKey, 'nvapi-x');
  assert.deepEqual(saved.suggestedModels, ['big', 'small']);
  assert.equal(saved.defaultModel, 'big');
  assert.ok(reg.calls.register >= 1, 'registered live');
});

test('addCustomProvider flags a builtin-name override', async () => {
  const reg = makeRegistry();
  const io = makeConfigIO();
  const r = await addCustomProvider({
    registry: reg, readConfig: io.readConfig, writeConfig: io.writeConfig,
    name: 'groq', baseUrl: 'https://my.groq.proxy/v1', apiKey: 'k',
  });
  assert.equal(r.builtinOverride, true);
});

test('addCustomProvider keeps the entry even when the probe fails', async () => {
  const reg = makeRegistry({ fetchThrows: 'ECONNREFUSED' });
  const io = makeConfigIO();
  const r = await addCustomProvider({
    registry: reg, readConfig: io.readConfig, writeConfig: io.writeConfig,
    name: 'vllm', baseUrl: 'http://localhost:8000/v1', apiKey: '',
  });
  assert.equal(r.probe.ok, false);
  assert.match(r.probe.error, /ECONNREFUSED/);
  const saved = io.peek().customProviders.find((p) => p.name === 'vllm');
  assert.ok(saved, 'entry persisted despite probe failure');
  assert.equal(saved.apiKey, undefined, 'auth-less endpoint stores no key');
});

test('addCustomProvider rejects a bad name before touching config', async () => {
  const reg = makeRegistry();
  const io = makeConfigIO();
  await assert.rejects(
    () => addCustomProvider({ registry: reg, readConfig: io.readConfig, writeConfig: io.writeConfig, name: 'bad name!', baseUrl: 'https://x/v1' }),
    /invalid provider name/,
  );
  assert.equal(io.peek().customProviders, undefined, 'config untouched');
});

test('addCustomProvider overwrites an existing entry of the same name', async () => {
  const reg = makeRegistry({ models: [] });
  const io = makeConfigIO({ customProviders: [{ name: 'nim', baseUrl: 'https://old/v1', apiKey: 'old' }] });
  await addCustomProvider({
    registry: reg, readConfig: io.readConfig, writeConfig: io.writeConfig,
    name: 'nim', baseUrl: 'https://new/v1', apiKey: 'new',
  });
  const all = io.peek().customProviders.filter((p) => p.name === 'nim');
  assert.equal(all.length, 1);
  assert.equal(all[0].baseUrl, 'https://new/v1');
  assert.equal(all[0].apiKey, 'new');
});
