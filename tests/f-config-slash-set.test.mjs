// tests/f-config-slash-set.test.mjs — /config learns to take arguments.
//
// Before this, `/config set provider claude-cli` opened a picker and ignored
// every argument. Over HTTP, where there is no picker, it reported success and
// changed nothing — the worst failure shape available: silent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runConfigSlash } from '../tui/config_picker.mjs';

// A ctx with no openPicker is exactly what the HTTP adapter supplies.
function mkCtx(initial = {}) {
  let cfg = { ...initial };
  return {
    readConfig: () => ({ ...cfg }),
    writeConfig: (next) => { cfg = { ...next }; },
    _read: () => cfg,
  };
}

test('set writes the key and reports what it stored', async () => {
  const ctx = mkCtx({ provider: 'claude-cli' });
  const out = await runConfigSlash('set model opus', ctx, new Map());
  assert.match(String(out), /model/);
  assert.equal(ctx._read().model, 'opus');
});

test('unset deletes the key', async () => {
  const ctx = mkCtx({ provider: 'claude-cli', model: 'opus' });
  await runConfigSlash('unset model', ctx, new Map());
  assert.equal('model' in ctx._read(), false);
});

test('a numeric-looking value is stored as a number, not a string', async () => {
  // config.json is typed; storing "4096" where a number belongs fails
  // validation later, far from the command that caused it.
  const ctx = mkCtx({ provider: 'claude-cli' });
  await runConfigSlash('set maxTokens 4096', ctx, new Map());
  assert.strictEqual(ctx._read().maxTokens, 4096);
  await runConfigSlash('set someFlag true', ctx, new Map());
  assert.strictEqual(ctx._read().someFlag, true);
  await runConfigSlash('set note hello', ctx, new Map());
  assert.strictEqual(ctx._read().note, 'hello');
});

test('a quoted value keeps its spaces', async () => {
  const ctx = mkCtx({ provider: 'claude-cli' });
  await runConfigSlash('set note "hello world"', ctx, new Map());
  assert.equal(ctx._read().note, 'hello world');
});

test('nested cargo is refused, exactly as the daemon route refuses it', async () => {
  // daemon/routes/config.mjs sends customProviders / rates / authProfiles to
  // dedicated endpoints so schema validation cannot be bypassed. The slash
  // path must not become the bypass.
  const ctx = mkCtx({ provider: 'claude-cli' });
  for (const key of ['customProviders', 'rates', 'authProfiles']) {
    const out = await runConfigSlash(`set ${key} x`, ctx, new Map());
    assert.match(String(out), /dedicated endpoint|not settable/i, `${key} must be refused`);
    assert.equal(key in ctx._read(), false);
  }
});

test('a write that would break the config is rejected and nothing is persisted', async () => {
  const ctx = mkCtx({ provider: 'claude-cli' });
  const out = await runConfigSlash('set provider not-a-real-provider', ctx, new Map());
  assert.match(String(out), /invalid|unknown|not/i);
  assert.equal(ctx._read().provider, 'claude-cli', 'the previous value survives a rejected write');
});

test('an api-key value is not echoed back in the clear', async () => {
  const ctx = mkCtx({ provider: 'claude-cli' });
  const out = await runConfigSlash('set api-key sk-ant-SECRETVALUE', ctx, new Map());
  assert.doesNotMatch(String(out), /SECRETVALUE/, 'the reply is rendered into a browser and a terminal');
  assert.equal(ctx._read()['api-key'], 'sk-ant-SECRETVALUE', 'but the real value is stored');
});

test('usage is reported for a malformed line, and nothing is written', async () => {
  const ctx = mkCtx({ provider: 'claude-cli' });
  for (const line of ['set', 'set onlykey', 'unset']) {
    const out = await runConfigSlash(line, ctx, new Map());
    assert.match(String(out), /usage/i, `"${line}" must explain itself`);
  }
  assert.deepEqual(ctx._read(), { provider: 'claude-cli' });
});

test('no arguments still opens the picker — the existing behaviour is untouched', async () => {
  let opened = false;
  const ctx = { ...mkCtx({}), openPicker: async () => { opened = true; return { id: 'CANCEL' }; } };
  await runConfigSlash('', ctx, new Map());
  assert.equal(opened, true);
});
