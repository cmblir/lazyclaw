// gemini-cli token accounting: the stats block carries per-model
// tokens.{prompt, candidates, thoughts, cached}. `thoughts` is reasoning
// output (billed as output) and was dropped, undercounting thinking-model
// spend; `cached` (a subset of prompt) was never surfaced for cache-read
// billing. Cost is 0 (the CLI runs on the user's Google login / quota).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUsage } from '../providers/gemini_cli.mjs';

test('gemini-cli extractUsage: thoughts add to output, input is NET of cached', () => {
  const u = extractUsage({ models: { 'gemini-2.5-pro': { tokens: { prompt: 100, candidates: 50, thoughts: 200, cached: 30 } } } });
  assert.equal(u.inputTokens, 70, 'NET input = 100 prompt - 30 cached (matches Anthropic; no double-bill)');
  assert.equal(u.outputTokens, 250, 'candidates + thoughts (reasoning is billed output)');
  assert.equal(u.cacheReadInputTokens, 30);
  assert.equal(u.totalCostUsd, 0);
});

test('gemini-cli extractUsage: sums across model entries; null when empty', () => {
  const u = extractUsage({ models: { a: { tokens: { prompt: 10, candidates: 5 } }, b: { tokens: { prompt: 3, candidates: 2 } } } });
  assert.equal(u.inputTokens, 13);
  assert.equal(u.outputTokens, 7);
  assert.equal(extractUsage({}), null);
  assert.equal(extractUsage(null), null);
});
