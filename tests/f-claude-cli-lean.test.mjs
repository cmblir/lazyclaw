import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs } from '../providers/claude_cli.mjs';

// Root cause of slow + "not smart" claude-cli turns: lazyclaw spawned `claude`
// in the user's normal environment, so EVERY turn loaded the user's global
// CLAUDE.md + skills + hooks + all MCP servers (~180k tokens, measured) and let
// Claude Code act on them — slow, and polluted by config lazyclaw never wanted.
// lazyclaw provides its own system prompt, so claude-cli must run LEAN.

test('claude-cli runs LEAN by default (no user CLAUDE.md / skills / hooks / MCP)', () => {
  const args = buildArgs('hello', {});
  const si = args.indexOf('--setting-sources');
  assert.ok(si >= 0, '--setting-sources must be present');
  assert.equal(args[si + 1], '', 'empty = load no user/project/local settings');
  assert.ok(args.includes('--strict-mcp-config'), 'no MCP servers loaded on every turn');
  // core streaming protocol flags are preserved
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('stream-json'));
  assert.ok(args.includes('--include-partial-messages'));
});

test('opts.lean === false restores the full Claude Code config (explicit opt-out)', () => {
  const args = buildArgs('hello', { lean: false });
  assert.ok(!args.includes('--setting-sources'));
  assert.ok(!args.includes('--strict-mcp-config'));
  assert.ok(args.includes('-p'));
});

test('model alias is still appended under lean', () => {
  const args = buildArgs('hi', { model: 'opus' });
  assert.deepEqual(args.slice(-2), ['--model', 'opus']);
});
