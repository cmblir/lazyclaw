// tests/p2-auth-store.test.mjs — P2 restore: persisting an api key for a
// built-in provider, so selecting (e.g.) anthropic with no key configured can
// prompt + store one. Pure, DI'd config IO — no disk.

import test from 'node:test';
import assert from 'node:assert/strict';

import { setAuthKey } from '../providers/auth_store.mjs';

function io(initial = {}) {
  let store = JSON.parse(JSON.stringify(initial));
  return {
    readConfig: () => JSON.parse(JSON.stringify(store)),
    writeConfig: (cfg) => { store = JSON.parse(JSON.stringify(cfg)); },
    peek: () => store,
  };
}

test('setAuthKey writes an active profile under authProfiles[provider]', () => {
  const c = io();
  const cfg = setAuthKey({ readConfig: c.readConfig, writeConfig: c.writeConfig, provider: 'anthropic', key: 'sk-ant-xyz' });
  assert.deepEqual(c.peek().authProfiles.anthropic, [{ label: 'default', key: 'sk-ant-xyz' }]);
  assert.equal(c.peek().authActiveProfile.anthropic, 'default');
  // returns the merged cfg so the caller can mirror it in-memory
  assert.equal(cfg.authProfiles.anthropic[0].key, 'sk-ant-xyz');
});

test('setAuthKey updates an existing profile of the same label in place', () => {
  const c = io({ authProfiles: { openai: [{ label: 'default', key: 'old' }] }, authActiveProfile: { openai: 'default' } });
  setAuthKey({ readConfig: c.readConfig, writeConfig: c.writeConfig, provider: 'openai', key: 'new' });
  assert.equal(c.peek().authProfiles.openai.length, 1);
  assert.equal(c.peek().authProfiles.openai[0].key, 'new');
});

test('setAuthKey preserves unrelated providers and config keys', () => {
  const c = io({ provider: 'ollama', authProfiles: { openai: [{ label: 'default', key: 'k' }] } });
  setAuthKey({ readConfig: c.readConfig, writeConfig: c.writeConfig, provider: 'anthropic', key: 'a' });
  assert.equal(c.peek().provider, 'ollama');
  assert.equal(c.peek().authProfiles.openai[0].key, 'k');
  assert.equal(c.peek().authProfiles.anthropic[0].key, 'a');
});
