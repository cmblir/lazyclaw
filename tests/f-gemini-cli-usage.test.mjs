// gemini-cli token accounting: the stats block carries per-model
// tokens.{prompt, candidates, thoughts, cached}. `thoughts` is reasoning
// output (billed as output) and was dropped, undercounting thinking-model
// spend; `cached` (a subset of prompt) was never surfaced for cache-read
// billing. Cost is 0 (the CLI runs on the user's Google login / quota).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractUsage, geminiCliProvider } from '../providers/gemini_cli.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-gemini.mjs');

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

// A FAILED turn is still metered: gemini-cli's --output-format json returns an
// `error` object even on exit 0, and the SAME JSON carries the partial token
// usage in `stats`. The provider used to throw on parsed.error BEFORE running
// extractUsage, so a failed-but-metered turn leaked its tokens past the cost
// cap. This drives a real spawn of the fake gemini binary and asserts onUsage
// fired for the failed turn (the provider still throws the error afterward).
test('gemini-cli: a failed turn still fires onUsage from the same JSON stats', async () => {
  let usage = null;
  let threw = null;
  try {
    for await (const _ of geminiCliProvider.sendMessage(
      [{ role: 'user', content: 'FAILMETERED' }],
      { bin: FAKE, onUsage: (u) => { usage = u; } },
    )) { /* drain — no text expected on the failed turn */ }
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, 'the failed turn still surfaces the CLI error');
  assert.notEqual(threw.code, 'CLI_MISSING', 'not misreported as a missing binary');
  assert.match(String(threw.message), /failed turn/, 'error message is the gemini error, not swallowed');
  assert.ok(usage, 'onUsage fired for the failed turn (it was metered)');
  assert.equal(usage.inputTokens, 100, 'NET input = 120 prompt - 20 cached');
  assert.equal(usage.outputTokens, 50, 'candidates 40 + thoughts 10');
  assert.equal(usage.cacheReadInputTokens, 20);
  assert.equal(usage.totalCostUsd, 0);
});

// Sanity: a clean success turn still yields text AND fires usage (the happy
// path the failed-turn fix must not regress).
test('gemini-cli: a successful turn yields text and fires onUsage', async () => {
  let usage = null;
  let out = '';
  for await (const chunk of geminiCliProvider.sendMessage(
    [{ role: 'user', content: 'hello' }],
    { bin: FAKE, onUsage: (u) => { usage = u; } },
  )) { out += chunk; }
  assert.equal(out, 'ok', 'response text yielded');
  assert.ok(usage, 'onUsage fired on success');
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 50);
});
