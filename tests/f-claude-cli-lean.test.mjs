import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs } from '../providers/claude_cli.mjs';

// Root cause of slow + "not smart" claude-cli turns: pompos spawned `claude`
// in the user's normal environment, so EVERY turn loaded the user's global
// CLAUDE.md + skills + hooks + all MCP servers (~180k tokens, measured) and let
// Claude Code act on them — slow, and polluted by config pompos never wanted.
// pompos provides its own system prompt, so claude-cli must run LEAN.

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

test('streaming chat is BOUNDED by default: --max-turns 1 + --tools "" (no autonomous loop)', () => {
  // Without this, a plain chat question triggers Claude Code's full internal
  // agent loop (measured 6-11 internal model calls, 90-126s). One turn, no tools.
  const args = buildArgs('hi', {});
  const mt = args.indexOf('--max-turns');
  assert.ok(mt >= 0, '--max-turns must be present');
  assert.equal(args[mt + 1], '1');
  const ti = args.indexOf('--tools');
  assert.ok(ti >= 0);
  assert.equal(args[ti + 1], '', 'tools disabled for a plain completion');
});

test('callers can raise the bound (maxTurns) and pass a tools whitelist', () => {
  const args = buildArgs('hi', { maxTurns: 8, tools: 'Read,Grep' });
  assert.equal(args[args.indexOf('--max-turns') + 1], '8');
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep');
});
