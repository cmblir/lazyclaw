import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolUseArgs } from '../providers/tool_use/claude_cli.mjs';

// The tool-use claude-cli adapter drives the agentic chat path, EVERY mention-
// router team turn, and BOTH per-turn trainer calls (skill synth + user model).
// It restricted tools (--tools) but never ran lean — so every one of those
// spawns re-loaded the user's CLAUDE.md/skills/MCP (~180k tokens measured),
// re-introducing exactly the cost the streaming provider's lean flags removed.

test('tool-use adapter runs LEAN by default (single-sourced with the streaming provider)', () => {
  const args = buildToolUseArgs({ prompt: 'hi', tools: [], permissionMode: 'bypassPermissions' });
  const si = args.indexOf('--setting-sources');
  assert.ok(si >= 0, '--setting-sources must be present');
  assert.equal(args[si + 1], '');
  assert.ok(args.includes('--strict-mcp-config'));
  // existing behaviour preserved
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('--tools'), 'tool whitelist still threaded');
  assert.ok(args.includes('bypassPermissions'));
});

test('tool-use adapter lean:false restores the full environment', () => {
  const args = buildToolUseArgs({ prompt: 'hi', tools: [], lean: false });
  assert.ok(!args.includes('--setting-sources'));
  assert.ok(!args.includes('--strict-mcp-config'));
});

test('tool-use adapter still maps model + system + tools whitelist', () => {
  const args = buildToolUseArgs({ prompt: 'hi', model: 'sonnet', system: 'be brief', tools: [{ name: 'bash' }, { name: 'read' }] });
  const mi = args.indexOf('--model'); assert.equal(args[mi + 1], 'sonnet');
  const sp = args.indexOf('--system-prompt'); assert.equal(args[sp + 1], 'be brief');
  const ti = args.indexOf('--tools'); assert.equal(args[ti + 1], 'Bash,Read');
});
