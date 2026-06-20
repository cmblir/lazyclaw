// tests/f-agent-tools-from-registry.test.mjs — agent tool grants were
// validated against a hardcoded 8-name ALL_TOOLS (with a stale, unregistered
// 'slack_post') that threw on anything else, so team agents could not be
// granted recall / delegate / git_* / edit / and ~40 other real registry
// tools — silently capping the whole multi-agent-team moat. Derive the valid
// set from the live tool registry instead.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerAgent, ALL_TOOLS } from '../agents.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc-agtool-'));

test('registerAgent can grant real registered tools (recall/edit/git_status/delegate)', () => {
  const a = registerAgent({ name: 'worker', provider: 'anthropic', model: 'x', tools: ['recall', 'edit', 'git_status', 'delegate'] }, tmp());
  assert.deepEqual(a.tools, ['recall', 'edit', 'git_status', 'delegate']);
});

test('registerAgent accepts an mcp:* tool name even though it registers dynamically', () => {
  const a = registerAgent({ name: 'w3', provider: 'anthropic', model: 'x', tools: ['mcp:fs:read_file'] }, tmp());
  assert.deepEqual(a.tools, ['mcp:fs:read_file']);
});

test('registerAgent still rejects a genuinely unknown tool', () => {
  assert.throws(() => registerAgent({ name: 'w2', provider: 'anthropic', model: 'x', tools: ['totally_fake_tool'] }, tmp()), /unknown tool/);
});

test('ALL_TOOLS no longer carries the stale unregistered slack_post and now spans the registry', () => {
  assert.ok(!ALL_TOOLS.includes('slack_post'), 'slack_post is not a registered tool');
  assert.ok(ALL_TOOLS.includes('recall') && ALL_TOOLS.includes('git_commit'), 'ALL_TOOLS must reflect the real registry');
});
