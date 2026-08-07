// tests/f-cli-login.test.mjs — inline connect/login for the keyless CLI
// providers. Picking codex-cli / gemini-cli in /provider or /login should,
// when the CLI isn't signed in, offer a connect action instead of dead-ending
// on the CLI's own "please log in" message.

import test from 'node:test';
import assert from 'node:assert/strict';
import { cliLoginStatus, CLI_LOGIN_PROVIDERS } from '../providers/cli_login.mjs';
import { maybeLoginForCli, runProviderLogin, loginSlash } from '../tui/login_flow.mjs';

// ── cliLoginStatus — dependency-injected detection ─────────────────────────

test('cliLoginStatus: unsupported provider', async () => {
  assert.deepEqual(await cliLoginStatus('openai'), { supported: false });
});

test('cliLoginStatus: binary missing → install path', async () => {
  const s = await cliLoginStatus('gemini-cli', { which: () => '' });
  assert.equal(s.binMissing, true);
  assert.equal(s.loggedIn, false);
  assert.equal(s.pkg, '@google/gemini-cli');
});

test('cliLoginStatus: codex uses `codex login status` exit code', async () => {
  const inDeps = { which: () => '/bin/codex' };
  const yes = await cliLoginStatus('codex-cli', { ...inDeps, runStatus: async () => 0 });
  const no = await cliLoginStatus('codex-cli', { ...inDeps, runStatus: async () => 1 });
  assert.equal(yes.loggedIn, true);
  assert.equal(no.loggedIn, false);
});

test('cliLoginStatus: gemini infers from creds file or GEMINI_API_KEY', async () => {
  const base = { which: () => '/bin/gemini', existsSync: () => false, env: {} };
  assert.equal((await cliLoginStatus('gemini-cli', base)).loggedIn, false);
  assert.equal((await cliLoginStatus('gemini-cli', { ...base, existsSync: () => true })).loggedIn, true);
  assert.equal((await cliLoginStatus('gemini-cli', { ...base, env: { GEMINI_API_KEY: 'k' } })).loggedIn, true);
});

test('cliLoginStatus: a stored pompos key counts as connected', async () => {
  const s = await cliLoginStatus('codex-cli', { which: () => '/bin/codex', hasStoredKey: true });
  assert.equal(s.loggedIn, true);
  assert.equal(s.via, 'api-key');
});

// ── maybeLoginForCli — menu decisions over a fake ctx ──────────────────────

function fakeCtx({ pick, openPicker } = {}) {
  const cfg = {};
  return {
    cfg,
    openPicker: openPicker || (async () => pick),
    resolveAuthKey: () => '',
    readConfig: () => cfg,
    writeConfig: (n) => Object.assign(cfg, n),
    getActiveProvName: () => 'codex-cli',
    setActiveProvName: () => {},
  };
}

const NOT_SIGNED_IN = { which: () => '/bin/codex', runStatus: async () => 1 };

test('maybeLoginForCli: already signed in → null (no prompt)', async () => {
  const ctx = fakeCtx({ pick: 'browser' });
  const r = await maybeLoginForCli(ctx, 'codex-cli', { statusDeps: { which: () => '/bin/codex', runStatus: async () => 0 } });
  assert.equal(r, null);
});

test('maybeLoginForCli: browser pick queues a foreground login', async () => {
  const ctx = fakeCtx({ pick: 'browser' });
  const r = await maybeLoginForCli(ctx, 'codex-cli', { statusDeps: NOT_SIGNED_IN });
  assert.equal(r.exit, true);
  assert.deepEqual(ctx.requestLogin, { provider: 'codex-cli', mode: 'browser' });
});

test('maybeLoginForCli: binary missing offers install', async () => {
  const ctx = fakeCtx({ pick: 'install' });
  const r = await maybeLoginForCli(ctx, 'gemini-cli', { statusDeps: { which: () => '' } });
  assert.equal(r.exit, true);
  assert.deepEqual(ctx.requestLogin, { provider: 'gemini-cli', mode: 'install' });
});

test('maybeLoginForCli: gemini API key is saved inline (no EXIT)', async () => {
  const ctx = fakeCtx({ pick: 'apikey' });
  const r = await maybeLoginForCli(ctx, 'gemini-cli', {
    statusDeps: { which: () => '/bin/gemini', existsSync: () => false, env: {} },
    promptText: async () => 'AIza-test-key',
  });
  assert.equal(r.exit, false);
  assert.match(r.msg, /API key saved/);
  assert.ok(ctx.cfg.authProfiles && ctx.cfg.authProfiles['gemini-cli']?.length, 'key persisted under gemini-cli');
});

test('maybeLoginForCli: codex API key defers to `codex login --with-api-key`', async () => {
  const ctx = fakeCtx({ pick: 'apikey' });
  const r = await maybeLoginForCli(ctx, 'codex-cli', {
    statusDeps: NOT_SIGNED_IN,
    promptText: async () => 'sk-test',
  });
  assert.equal(r.exit, true);
  assert.equal(ctx.requestLogin.mode, 'apikey');
  assert.equal(ctx.requestLogin.apiKey, 'sk-test');
});

test('maybeLoginForCli: skip surfaces a /login hint and does not EXIT', async () => {
  const ctx = fakeCtx({ pick: 'skip' });
  const r = await maybeLoginForCli(ctx, 'codex-cli', { statusDeps: NOT_SIGNED_IN });
  assert.equal(r.exit, false);
  assert.match(r.msg, /\/login codex-cli/);
  assert.equal(ctx.requestLogin, undefined);
});

// ── runProviderLogin / loginSlash wiring ───────────────────────────────────

test('runProviderLogin persists the provider before handing off to EXIT', async () => {
  const ctx = fakeCtx({ pick: 'browser' });
  const r = await runProviderLogin(ctx, 'codex-cli', { statusDeps: NOT_SIGNED_IN });
  assert.equal(r, 'EXIT');
  assert.equal(ctx.cfg.provider, 'codex-cli');
});

test('loginSlash rejects non-CLI providers and needs the interactive UI', async () => {
  const out = await loginSlash('openai', { getActiveProvName: () => 'openai' });
  assert.match(out, /keyless CLI providers/);
  // No openPicker (legacy ctx) → actionable shell hint, not a false "connected".
  const hint = await loginSlash('codex-cli', { getActiveProvName: () => 'codex-cli' });
  assert.match(hint, /needs the interactive UI/);
});
