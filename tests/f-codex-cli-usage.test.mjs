// codex-cli token accounting: cached_input_tokens is a SUBSET of input_tokens,
// and reasoning_output_tokens is a subset of output_tokens (the OpenAI
// Responses-API billing convention codex follows). Summing them double-counts,
// which over-states input/output and trips the daemon cost cap early. Report
// input NET of cached (total minus cached) to match Anthropic's convention so
// rates.mjs doesn't bill the cached subset at BOTH the input rate and the
// cache-read rate, and surface cached input separately for cache-read billing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUsage } from '../providers/codex_cli.mjs';

test('codex extractUsage: input is NET of cached (not double-billed); cached surfaced as cacheRead', () => {
  const u = extractUsage({
    type: 'turn.completed',
    usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 0 },
  });
  assert.equal(u.inputTokens, 315, 'NET input = 24763 - 24448 cached (matches Anthropic; no double-bill)');
  assert.equal(u.cacheReadInputTokens, 24448, 'cached surfaced separately for cache-read billing');
  assert.equal(u.outputTokens, 122);
  assert.equal(u.totalCostUsd, 0);
});

test('codex extractUsage: reasoning_output_tokens does not double-count output', () => {
  const u = extractUsage({
    type: 'turn.completed',
    usage: { input_tokens: 100, output_tokens: 500, reasoning_output_tokens: 300 },
  });
  assert.equal(u.outputTokens, 500, 'output_tokens already includes reasoning — not 800');
  assert.equal(u.inputTokens, 100);
  assert.equal(u.cacheReadInputTokens, 0);
});

test('codex extractUsage: null for non-completion events or empty usage', () => {
  assert.equal(extractUsage({ type: 'turn.started' }), null);
  assert.equal(extractUsage({ type: 'turn.completed', usage: {} }), null);
  assert.equal(extractUsage(null), null);
});
