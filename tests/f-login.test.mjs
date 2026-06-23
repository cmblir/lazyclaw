import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveClaudeAuth, cmdLogin } from '../commands/login.mjs';

const FILE_BLOB = JSON.stringify({ claudeAiOauth: { accessToken: 'file-tok' } });

test('resolveClaudeAuth: env token wins', () => {
  const s = resolveClaudeAuth({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' }, readFileSync: () => { throw new Error('no'); }, keychainReader: () => null });
  assert.deepEqual(s, { authenticated: true, source: 'env' });
});

test('resolveClaudeAuth: macOS keychain when no env / file', () => {
  const s = resolveClaudeAuth({ env: {}, home: '/h', readFileSync: () => { throw new Error('ENOENT'); }, keychainReader: () => 'kc-tok' });
  assert.deepEqual(s, { authenticated: true, source: 'keychain' });
});

test('resolveClaudeAuth: credential file before keychain', () => {
  const s = resolveClaudeAuth({ env: {}, home: '/h', readFileSync: () => FILE_BLOB, keychainReader: () => 'kc-tok' });
  assert.deepEqual(s, { authenticated: true, source: 'file' });
});

test('resolveClaudeAuth: none when nothing is present', () => {
  const s = resolveClaudeAuth({ env: {}, home: '/h', readFileSync: () => { throw new Error('ENOENT'); }, keychainReader: () => null });
  assert.deepEqual(s, { authenticated: false, source: 'none' });
});

function cap() {
  const out = []; const errs = [];
  return { out, errs, log: (s) => out.push(s), err: (s) => errs.push(s) };
}

test('cmdLogin --token saves it to .env and reports success', async () => {
  const c = cap(); const wrote = [];
  const code = await cmdLogin([], { token: 'minted-123' }, { ...c, cfgDir: '/cfg', writeEnv: (v) => wrote.push(v), resolve: () => ({ authenticated: false, source: 'none' }) });
  assert.equal(code, 0);
  assert.deepEqual(wrote[0], { CLAUDE_CODE_OAUTH_TOKEN: 'minted-123' });
  assert.match(c.out.join('\n'), /saved/i);
});

test('cmdLogin: already authenticated → success, no setup-token spawn', async () => {
  const c = cap(); let spawned = false;
  const code = await cmdLogin([], {}, { ...c, resolve: () => ({ authenticated: true, source: 'keychain' }), runSetupToken: async () => { spawned = true; return 0; } });
  assert.equal(code, 0);
  assert.equal(spawned, false);
  assert.match(c.out.join('\n'), /already authenticated|Keychain/i);
});

test('cmdLogin --check: exits 1 when unauthenticated and does NOT spawn', async () => {
  const c = cap(); let spawned = false;
  const code = await cmdLogin([], { check: true }, { ...c, resolve: () => ({ authenticated: false, source: 'none' }), runSetupToken: async () => { spawned = true; return 0; } });
  assert.equal(code, 1);
  assert.equal(spawned, false);
});

test('cmdLogin: unauthenticated with claude present → runs setup-token then instructs', async () => {
  const c = cap(); let spawned = false;
  const code = await cmdLogin([], {}, { ...c, resolve: () => ({ authenticated: false, source: 'none' }), hasClaudeBinary: () => true, runSetupToken: async () => { spawned = true; return 0; } });
  assert.equal(spawned, true);
  assert.equal(code, 0);
  assert.match(c.out.join('\n'), /login --token|CLAUDE_CODE_OAUTH_TOKEN/);
});

test('cmdLogin: unauthenticated, no claude binary → install guidance, exit 1', async () => {
  const c = cap();
  const code = await cmdLogin([], {}, { ...c, resolve: () => ({ authenticated: false, source: 'none' }), hasClaudeBinary: () => false });
  assert.equal(code, 1);
  assert.match(c.out.join('\n') + c.errs.join('\n'), /claude login|install/i);
});

test('cmdLogin: rejects an unsupported provider', async () => {
  const c = cap();
  const code = await cmdLogin(['openai'], {}, { ...c });
  assert.equal(code, 2);
});
