// tests/f-tooluse-usage.test.mjs
//
// The tool-use adapters' parseResponse returned text/kind/raw but dropped the
// token-usage counts the API responses carry, so a team agent turn could never
// report what it spent — team traffic bypassed the cost cap entirely. Each
// parser now normalizes usage to { inputTokens, outputTokens } (or null when
// the response has none) so agent_turn can accumulate it up to the metrics.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResponse as anthropicParse } from '../providers/tool_use/anthropic.mjs';
import { parseResponse as openaiParse } from '../providers/tool_use/openai.mjs';
import { parseResponse as geminiParse } from '../providers/tool_use/gemini.mjs';

test('anthropic parseResponse normalizes usage (incl. cache tokens)', () => {
  const r = anthropicParse({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 7 } });
  assert.deepEqual(r.usage, { inputTokens: 11, outputTokens: 7, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
  const c = anthropicParse({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 7, cache_creation_input_tokens: 3000, cache_read_input_tokens: 500 } });
  assert.deepEqual(c.usage, { inputTokens: 11, outputTokens: 7, cacheCreationInputTokens: 3000, cacheReadInputTokens: 500 });
});

test('openai parseResponse normalizes usage', () => {
  const r = openaiParse({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 13, completion_tokens: 5 } });
  assert.deepEqual(r.usage, { inputTokens: 13, outputTokens: 5 });
});

test('gemini parseResponse normalizes usage (incl. cached content tokens)', () => {
  const r = geminiParse({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 } });
  assert.deepEqual(r.usage, { inputTokens: 9, outputTokens: 4, cacheReadInputTokens: 0 });
  const c = geminiParse({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, cachedContentTokenCount: 3 } });
  assert.deepEqual(c.usage, { inputTokens: 9, outputTokens: 4, cacheReadInputTokens: 3 });
});

test('usage is null when the response carries no token counts', () => {
  const r = anthropicParse({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' });
  assert.equal(r.usage, null);
});
