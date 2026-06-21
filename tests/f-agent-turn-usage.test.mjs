// tests/f-agent-turn-usage.test.mjs
//
// runAgentTurn drives a provider's tool-use loop (callOnce per iteration). It
// now accumulates each call's normalized usage and returns the total, so the
// team router can report a turn's spend to the cost cap. Pins that the total
// surfaces, and is null when the adapter reports no usage.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentTurn } from '../mas/agent_turn.mjs';

const fakeFinalFetch = (body) => async () => ({ ok: true, json: async () => body });

test('runAgentTurn accumulates token usage from the adapter', async () => {
  const body = { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 21, output_tokens: 9 } };
  const res = await runAgentTurn({
    agent: { name: 'a', provider: 'anthropic', model: 'claude-opus-4-7', role: 'r' },
    userMessage: 'hi', apiKey: 'sk', fetchImpl: fakeFinalFetch(body),
  });
  assert.equal(res.stoppedBy, 'final');
  assert.deepEqual(res.usage, { inputTokens: 21, outputTokens: 9 });
});

test('runAgentTurn returns null usage when the adapter reports none', async () => {
  const body = { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' };
  const res = await runAgentTurn({
    agent: { name: 'a', provider: 'anthropic', model: 'claude-opus-4-7', role: 'r' },
    userMessage: 'hi', apiKey: 'sk', fetchImpl: fakeFinalFetch(body),
  });
  assert.equal(res.usage, null);
});
