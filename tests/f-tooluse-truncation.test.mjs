// tests/f-tooluse-truncation.test.mjs — the tool_use adapters ignored the
// provider's finish reason, so a max_tokens-TRUNCATED turn parsed as a clean
// `final` (Anthropic/Gemini) or emitted partial/empty tool args (OpenAI) and
// agent_turn acted on it. parseResponse must flag truncation so the runner can
// stop instead of reasoning forward on a cut-off response.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResponse as parseAnthropic } from '../providers/tool_use/anthropic.mjs';
import { parseResponse as parseOpenAI } from '../providers/tool_use/openai.mjs';
import { parseResponse as parseGemini } from '../providers/tool_use/gemini.mjs';
import { runAgentTurn } from '../mas/agent_turn.mjs';

test('anthropic parseResponse flags a max_tokens truncation', () => {
  const cut = parseAnthropic({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'partial' }] });
  assert.equal(cut.truncated, true, 'stop_reason max_tokens must set truncated');
  const ok = parseAnthropic({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] });
  assert.ok(!ok.truncated, 'a normal end_turn is not truncated');
});

test('openai parseResponse flags a length (token-limit) truncation', () => {
  const cut = parseOpenAI({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] });
  assert.equal(cut.truncated, true, 'finish_reason length must set truncated');
  const ok = parseOpenAI({ choices: [{ finish_reason: 'stop', message: { content: 'done' } }] });
  assert.ok(!ok.truncated, 'finish_reason stop is not truncated');
});

test('gemini parseResponse flags a MAX_TOKENS / SAFETY / RECITATION truncation', () => {
  for (const fr of ['MAX_TOKENS', 'SAFETY', 'RECITATION']) {
    const cut = parseGemini({ candidates: [{ finishReason: fr, content: { parts: [{ text: 'partial' }] } }] });
    assert.equal(cut.truncated, true, `finishReason ${fr} must set truncated`);
  }
  const ok = parseGemini({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'done' }] } }] });
  assert.ok(!ok.truncated, 'finishReason STOP is not truncated');
});

test('a truncated tool_calls turn is still flagged truncated (do not act on partial calls)', () => {
  const cut = parseAnthropic({
    stop_reason: 'max_tokens',
    content: [{ type: 'tool_use', id: 'x', name: 't', input: {} }],
  });
  assert.equal(cut.truncated, true);
});

test('runAgentTurn stops with stoppedBy=truncated on a length-cut response (does not return it as final)', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: 'partial answer cut off' } }] }) });
  const r = await runAgentTurn({
    agent: { provider: 'openai', model: 'gpt-4', tools: [] },
    userMessage: 'hi', fetchImpl, apiKey: 'k',
    // omit configDir → no trajectory disk side effects
  });
  assert.equal(r.stoppedBy, 'truncated', 'a truncated turn must not be reported as a clean final');
  assert.match(r.error || '', /truncat/i);
});

test('runAgentTurn surfaces an OpenAI malformed-args tool call as a tool failure (not silent {})', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) {
      // First turn: a tool_call whose arguments JSON is malformed (not truncated).
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c1', function: { name: 'noop', arguments: '{bad json' } }] } }] }) };
    }
    // Second turn: the model gives up with a final answer.
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'ok done' } }] }) };
  };
  const r = await runAgentTurn({
    agent: { provider: 'openai', model: 'gpt-4', tools: ['noop'] },
    userMessage: 'hi', fetchImpl, apiKey: 'k', maxIterations: 3,
  });
  const failed = (r.toolCalls || []).find((t) => t.name === 'noop');
  assert.ok(failed, 'the malformed tool call must be recorded');
  assert.equal(failed.ok, false, 'malformed args must be a tool failure, not a silent {} run');
  assert.match(failed.result?.error || '', /malformed/i);
});
