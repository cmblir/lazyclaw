// P1 — real claude-cli session detection (the $0-trainer headline).
// Asserts only the deterministic signals (env token, credential store); the
// PATH-binary fallback depends on the host so it is exercised by code, not
// asserted here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectClaudeCliSession, hasClaudeCliSession } from '../providers/claude_cli_detect.mjs';
import { resolveTrainer } from '../providers/registry.mjs';

test('detects an explicit CLAUDE_CODE_OAUTH_TOKEN', () => {
  const r = detectClaudeCliSession({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, home: '/no-such-home-xyz' });
  assert.equal(r.available, true);
  assert.equal(r.source, 'env');
});

test('detects a credential store written by `claude login`', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-claude-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}');
  const r = detectClaudeCliSession({ env: {}, home });
  assert.equal(r.available, true);
  assert.equal(r.source, 'credentials');
});

test('hasClaudeCliSession respects explicit opts (token present → true)', () => {
  assert.equal(hasClaudeCliSession({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, home: '/no' }), true);
});

test('resolveTrainer auto routes to claude-cli when a session is detected', () => {
  const detect = () => true;
  const got = resolveTrainer(
    { provider: 'anthropic', model: 'claude-opus-4-7', trainer: { provider: 'auto' } },
    { detectClaudeCli: detect },
  );
  assert.equal(got.provider, 'claude-cli');
});

test('resolveTrainer auto mirrors the (paid) chat provider when no session is detected', () => {
  const got = resolveTrainer(
    { provider: 'anthropic', model: 'claude-opus-4-7', trainer: { provider: 'auto' } },
    { detectClaudeCli: () => false },
  );
  assert.equal(got.provider, 'anthropic');
});
