// tests/p2-key-entry.test.mjs — P2 restore: when the interactive /provider
// picker lands on a built-in api-key provider that has no key configured, the
// Ink flow prompts for one and persists it (the v5.4 port silently switched
// with no key and no warning).

import test from 'node:test';
import assert from 'node:assert/strict';

import { dispatchSlash } from '../tui/slash_dispatcher.mjs';

function makeCtx({ resolvedKey = '' } = {}) {
  let store = {};
  let provName = 'ollama';
  const PROVIDERS = { anthropic: {}, ollama: {}, 'claude-cli': {}, mock: {} };
  const PROVIDER_INFO = {
    anthropic: { requiresApiKey: true },
    ollama: { requiresApiKey: false },
    'claude-cli': { requiresApiKey: false },
  };
  const registry = { PROVIDERS, PROVIDER_INFO, lookupProv: (n) => PROVIDERS[n] || null };
  const cfg = {};
  return {
    cfg,
    registryMod: registry,
    readConfig: () => JSON.parse(JSON.stringify(store)),
    writeConfig: (c) => { store = JSON.parse(JSON.stringify(c)); },
    resolveAuthKey: () => resolvedKey,
    getActiveProvName: () => provName,
    setActiveProvName: (n) => { provName = n; },
    getActiveModel: () => null,
    setProv: () => {},
    getProv: () => ({}),
    _peek: () => store,
  };
}

test('selecting a keyless built-in provider does NOT prompt for a key', async () => {
  const kinds = [];
  const ctx = makeCtx();
  ctx.openPicker = async (opts) => {
    kinds.push(opts.kind);
    if (opts.kind === 'provider-family') return 'cli';
    return 'claude-cli';
  };
  const out = await dispatchSlash('/provider', '', ctx);
  assert.match(out, /provider → claude-cli/);
  assert.ok(!kinds.includes('text'), 'no key prompt for a keyless provider');
});

test('selecting an api-key provider with no key prompts + persists the key', async () => {
  const ctx = makeCtx({ resolvedKey: '' });
  ctx.openPicker = async (opts) => {
    if (opts.kind === 'provider-family') return 'api';
    if (opts.kind === 'provider') return 'anthropic';
    if (opts.kind === 'text') return { id: '__text__', query: 'sk-ant-secret' };
    return null;
  };
  const out = await dispatchSlash('/provider', '', ctx);
  assert.equal(ctx.getActiveProvName(), 'anthropic');
  assert.equal(ctx._peek().authProfiles.anthropic[0].key, 'sk-ant-secret');
  // mirrored in-memory so the next turn resolves it without a restart
  assert.equal(ctx.cfg.authProfiles.anthropic[0].key, 'sk-ant-secret');
  assert.match(out, /provider → anthropic/);
});

test('an api-key provider that already has a key is not re-prompted', async () => {
  const ctx = makeCtx({ resolvedKey: 'sk-ant-existing' });
  const kinds = [];
  ctx.openPicker = async (opts) => {
    kinds.push(opts.kind);
    if (opts.kind === 'provider-family') return 'api';
    return 'anthropic';
  };
  await dispatchSlash('/provider', '', ctx);
  assert.ok(!kinds.includes('text'), 'no prompt when a key already resolves');
});
