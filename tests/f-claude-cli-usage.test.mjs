// The claude-cli one-shot path must surface REAL per-turn usage.
//
// Under `--output-format stream-json --include-partial-messages` the final
// `result` event reports ZERO token usage (verified on claude 2.1.185); the
// truthful per-turn usage rides the `assistant` message event. The provider
// used to read `result.usage` and therefore reported 0 input/0 output tokens to
// cost accounting (cost via total_cost_usd was fine). This pins the fix: usage
// is accumulated from `assistant` events and emitted with the result's cost.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeCliProvider } from '../providers/claude_cli.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');

test('claude-cli one-shot surfaces usage from the assistant event (not the zero-usage result)', async () => {
  let usage = null;
  // fake-claude one-shot emits assistant.usage {input:2, cache_creation:3189,
  // output:2 ("ok")} then a result with total_cost_usd:0.0123 and usage all 0.
  for await (const _ of claudeCliProvider.sendMessage(
    [{ role: 'user', content: 'hi' }],
    { bin: FAKE, onUsage: (u) => { usage = u; } },
  )) { /* drain the stream */ }
  assert.ok(usage, 'onUsage fired');
  assert.equal(usage.inputTokens, 2, 'input from the assistant event, not result (0)');
  assert.equal(usage.outputTokens, 2, 'output from the assistant event, not result (0)');
  assert.equal(usage.cacheCreationInputTokens, 3189, 'cache-creation surfaced too');
  assert.equal(usage.cacheReadInputTokens, 0);
  assert.equal(usage.totalCostUsd, 0.0123, 'cost still from the result event');
});
