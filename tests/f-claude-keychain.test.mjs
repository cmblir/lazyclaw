import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClaudeKeychainToken } from '../providers/claude_keychain.mjs';
import { _claudeCodeOAuthToken } from '../providers/model_catalogue.mjs';

// The real blob shape, verified against `security find-generic-password -s
// "Claude Code-credentials" -w` on macOS: a JSON object whose claudeAiOauth.
// accessToken is the bearer the platform accepts.
const blob = (tok = 'sk-ant-oat-123') => JSON.stringify({
  mcpOAuth: {},
  claudeAiOauth: { accessToken: tok, refreshToken: 'r', expiresAt: 9999999999999, scopes: ['user:inference'], subscriptionType: 'max' },
});

test('reads the access token from the macOS keychain item', () => {
  const calls = [];
  const tok = readClaudeKeychainToken({ platform: 'darwin', exec: (args) => { calls.push(args); return blob(); } });
  assert.equal(tok, 'sk-ant-oat-123');
  assert.deepEqual(calls[0], ['find-generic-password', '-s', 'Claude Code-credentials', '-w']);
});

test('returns null off macOS without shelling out to security', () => {
  let called = false;
  const tok = readClaudeKeychainToken({ platform: 'linux', exec: () => { called = true; return blob(); } });
  assert.equal(tok, null);
  assert.equal(called, false, 'security is macOS-only — must not run elsewhere');
});

test('returns null when security throws (no item, or access denied)', () => {
  assert.equal(readClaudeKeychainToken({ platform: 'darwin', exec: () => { throw new Error('SecKeychainSearchCopyNext: not found'); } }), null);
});

test('returns null on an empty / non-JSON / tokenless blob', () => {
  assert.equal(readClaudeKeychainToken({ platform: 'darwin', exec: () => '' }), null);
  assert.equal(readClaudeKeychainToken({ platform: 'darwin', exec: () => 'not json' }), null);
  assert.equal(readClaudeKeychainToken({ platform: 'darwin', exec: () => JSON.stringify({ claudeAiOauth: {} }) }), null);
});

test('_claudeCodeOAuthToken falls back to the keychain when no credential file exists', () => {
  const tok = _claudeCodeOAuthToken({
    home: '/no/such/home',
    readFileSync: () => { throw new Error('ENOENT'); },
    keychainReader: () => 'sk-ant-oat-from-kc',
  });
  assert.equal(tok, 'sk-ant-oat-from-kc');
});

test('_claudeCodeOAuthToken prefers the credential file over the keychain', () => {
  const tok = _claudeCodeOAuthToken({
    home: '/home/u',
    readFileSync: () => JSON.stringify({ claudeAiOauth: { accessToken: 'from-file' } }),
    keychainReader: () => 'from-kc',
  });
  assert.equal(tok, 'from-file');
});
