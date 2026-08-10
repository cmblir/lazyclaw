// tests/f-config-slash-set.test.mjs — /config learns to take arguments.
//
// Before this, `/config set provider claude-cli` opened a picker and ignored
// every argument. Over HTTP, where there is no picker, it reported success and
// changed nothing — the worst failure shape available: silent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runConfigSlash } from '../tui/config_picker.mjs';
import { makeSlashRunner } from '../daemon/lib/slash_http.mjs';
import { makeConfirmStore } from '../daemon/lib/confirm_tokens.mjs';

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
  // A real write must NOT trip the failure signal daemon/lib/slash_http.mjs
  // watches — that would turn a successful set into an ok:false envelope.
  assert.equal(ctx.__persistFailed, undefined);
});

test('unset deletes the key', async () => {
  const ctx = mkCtx({ provider: 'claude-cli', model: 'opus' });
  await runConfigSlash('unset model', ctx, new Map());
  assert.equal('model' in ctx._read(), false);
  assert.equal(ctx.__persistFailed, undefined);
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
    // Fix round 1: the string was already honest; the ENVELOPE was not — a
    // refusal must trip the same ctx.__persistFailed signal /provider and
    // /model already use, or daemon/lib/slash_http.mjs reports ok:true.
    assert.ok(ctx.__persistFailed, `${key}: refusal must set ctx.__persistFailed`);
  }
});

test('a write that would break the config is rejected and nothing is persisted', async () => {
  const ctx = mkCtx({ provider: 'claude-cli' });
  const out = await runConfigSlash('set provider not-a-real-provider', ctx, new Map());
  assert.match(String(out), /invalid|unknown|not/i);
  assert.equal(ctx._read().provider, 'claude-cli', 'the previous value survives a rejected write');
  assert.ok(ctx.__persistFailed, 'a validation rejection must set ctx.__persistFailed');
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
    assert.ok(ctx.__persistFailed, `"${line}": a malformed line must set ctx.__persistFailed`);
  }
  assert.deepEqual(ctx._read(), { provider: 'claude-cli' });
});

test('no arguments still opens the picker — the existing behaviour is untouched', async () => {
  let opened = false;
  const ctx = { ...mkCtx({}), openPicker: async () => { opened = true; return { id: 'CANCEL' }; } };
  await runConfigSlash('', ctx, new Map());
  assert.equal(opened, true);
});

// --- fix round 1: the ENVELOPE, not just the message, must say whether the
// write happened ------------------------------------------------------------
//
// Every string above is honest, but daemon/lib/slash_http.mjs's adapter
// cannot read prose to decide ok/false — and the panel task's prescribed
// button handler is `if (out.ok) load(); else banner(out.error)`, so a
// rejected config write that still comes back ok:true would refresh the
// panel and show the operator nothing. These run the SAME command through
// the real HTTP adapter (real dispatcher, no mock) and assert on the
// envelope itself, plus the actual config.json on disk — the ctx.__persistFailed
// checks above prove the signal is set; these prove daemon/lib/slash_http.mjs's
// finalizeEnvelope actually turns it into ok:false end to end, and that a
// real write still comes back ok:true.
function withTempConfigDir(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-config-slash-set-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(initial));
  return {
    dir,
    readDisk: () => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

async function withEnvelope(initial, fn) {
  const { dir, readDisk, cleanup } = withTempConfigDir(initial);
  const prevEnv = process.env.POMPOS_CONFIG_DIR;
  process.env.POMPOS_CONFIG_DIR = dir;
  try {
    const runner = makeSlashRunner({ cfgDir: dir, confirmStore: makeConfirmStore() }); // real dispatch, no mock
    await fn({ runner, readDisk });
  } finally {
    process.env.POMPOS_CONFIG_DIR = prevEnv;
    cleanup();
  }
}

test('envelope: a successful /config set is ok:true and lands on disk', async () => {
  await withEnvelope({ provider: 'claude-cli' }, async ({ runner, readDisk }) => {
    const out = await runner.run({ line: '/config set model opus' });
    assert.equal(out.ok, true);
    assert.equal(readDisk().model, 'opus');
  });
});

test('envelope: a validation-rejected /config set is ok:false and disk is untouched', async () => {
  await withEnvelope({ provider: 'claude-cli' }, async ({ runner, readDisk }) => {
    const before = readDisk();
    const out = await runner.run({ line: '/config set provider not-a-real-provider' });
    assert.equal(out.ok, false, 'validation rejected the write — the envelope must say so, not just the string');
    assert.deepEqual(readDisk(), before);
  });
});

test('envelope: nested cargo via /config set is ok:false and disk is untouched', async () => {
  await withEnvelope({ provider: 'claude-cli' }, async ({ runner, readDisk }) => {
    const before = readDisk();
    const out = await runner.run({ line: '/config set rates x' });
    assert.equal(out.ok, false, 'nested cargo was refused — the envelope must say so');
    assert.deepEqual(readDisk(), before);
  });
});

test('envelope: a malformed /config set (usage) is ok:false and disk is untouched', async () => {
  await withEnvelope({ provider: 'claude-cli' }, async ({ runner, readDisk }) => {
    const before = readDisk();
    const out = await runner.run({ line: '/config set onlykey' });
    assert.equal(out.ok, false, 'a malformed line never wrote anything — the envelope must say so');
    assert.deepEqual(readDisk(), before);
  });
});

test('envelope: a confirmed /config unset is ok:true and removes the key from disk', async () => {
  await withEnvelope({ provider: 'claude-cli', model: 'opus' }, async ({ runner, readDisk }) => {
    // /config unset is gated by daemon/lib/slash_destructive.mjs — the first
    // call only asks; it must not run (and must not claim to).
    const asked = await runner.run({ line: '/config unset model' });
    assert.equal(asked.ok, false);
    assert.equal(asked.code, 'CONFIRM_REQUIRED');
    assert.equal(readDisk().model, 'opus', 'unconfirmed — nothing may change yet');

    const out = await runner.run({ line: '/config unset model', confirm: asked.token });
    assert.equal(out.ok, true);
    assert.equal('model' in readDisk(), false);
  });
});
