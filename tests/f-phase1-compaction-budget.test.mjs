// tests/f-phase1-compaction-budget.test.mjs
//
// Phase 1 wave-A (compaction-budget). Two audit defects, both OPT-IN so the
// existing byte-stable tool-use / chat contracts stay green:
//
//   DEFECT A — no context compaction. A flat, unbounded transcript craters
//   accuracy past ~50-100k tokens. `compactMessages` (chat_window.mjs) does a
//   cheap, deterministic, $0 two-layer compaction: (L1) cap oversized tool
//   RESULT blocks with an elision marker; (L2) when still over budget, drop the
//   OLDEST turns (keep system + most-recent N verbatim) leaving one
//   "[...N earlier turns elided...]" note. runAgentTurn only invokes it when
//   opts.compact = { maxTokens } is set.
//
//   DEFECT B — no per-run budget ceiling. runAgentTurn accumulates usageTotal
//   but can't stop on a ceiling. opts.budget = { maxTokens?, maxCostUsd? } stops
//   the loop with stoppedBy:'budget_exceeded' before the next adapter.callOnce.
//
//   Neither option set => behavior is byte-identical to before (regression guard).

import test from 'node:test';
import assert from 'node:assert/strict';
import { compactMessages, estimateMessagesTokens } from '../chat_window.mjs';
import { runAgentTurn } from '../mas/agent_turn.mjs';

// ---- DEFECT A: compactMessages helper (unit) ----

test('L1: an oversized tool_result (anthropic shape) is truncated with an elision marker', () => {
  const big = 'x'.repeat(50000);
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: big }] },
  ];
  const { messages: out } = compactMessages(messages, { maxTokens: 1e9, toolResultMaxChars: 200 });
  const tr = out[3].content[0];
  assert.ok(tr.content.length < big.length, 'oversized tool_result must shrink');
  assert.match(tr.content, /elided|truncat/i, 'must carry an elision marker');
  assert.equal(out[0].content, 'sys', 'system message untouched');
  assert.equal(out[1].content, 'hi', 'small non-tool content untouched');
});

test('L1: an oversized tool_result (openai role:tool shape, string content) is truncated', () => {
  const big = 'y'.repeat(50000);
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'tool', tool_call_id: 'c1', content: big },
  ];
  const { messages: out } = compactMessages(messages, { maxTokens: 1e9, toolResultMaxChars: 100 });
  assert.ok(out[1].content.length < big.length, 'oversized role:tool content must shrink');
  assert.match(out[1].content, /elided|truncat/i);
});

test('L2: over the token budget, oldest turns are elided (system + recent N kept verbatim)', () => {
  const messages = [{ role: 'system', content: 'SYSTEM PROMPT' }];
  // 12 chunky turns; each ~1000 chars ≈ 250 tokens.
  for (let i = 0; i < 12; i++) {
    messages.push({ role: i % 2 ? 'assistant' : 'user', content: `turn-${i} ` + 'z'.repeat(1000) });
  }
  const recentBefore = messages[messages.length - 1].content;
  const { messages: out, elidedTurns } = compactMessages(messages, { maxTokens: 800, keepRecentTurns: 2 });
  assert.ok(elidedTurns > 0, 'some old turns must be elided');
  assert.equal(out[0].content, 'SYSTEM PROMPT', 'system prompt kept verbatim');
  // The elision note is a single synthetic turn.
  const note = out.find((m) => /earlier turns elided/i.test(String(m.content)));
  assert.ok(note, 'a single elision note must be present');
  assert.match(String(note.content), new RegExp(`${elidedTurns} earlier turns elided`));
  // The most-recent turn survives verbatim.
  assert.equal(out[out.length - 1].content, recentBefore, 'most-recent turn kept verbatim');
  assert.ok(estimateMessagesTokens(out) <= estimateMessagesTokens(messages), 'compaction must not grow the transcript');
});

test('compactMessages does not mutate the input array', () => {
  const big = 'x'.repeat(50000);
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: big }] },
  ];
  compactMessages(messages, { maxTokens: 10, toolResultMaxChars: 50 });
  assert.equal(messages[1].content[0].content.length, big.length, 'original messages must not be mutated');
});

// ---- DEFECT A: runAgentTurn wiring (opt-in) ----

test('runAgentTurn with opts.compact truncates an oversized tool result fed back to the model', async () => {
  // regex_match is a real, non-sensitive tool. Small INPUT (so the assistant's
  // tool_use echo stays small — L1 only compacts tool RESULTS, not the model's
  // own emitted args) but a large RESULT: a global single-char match over a
  // 4000-char text yields a 4000-element matches[] array whose serialized
  // tool_result content is well over the 500-char cap. No injection hook.
  const text = 'B'.repeat(4000);
  let calls = 0;
  let secondRequestMessages = null;
  const fetchImpl = async (_url, init) => {
    calls++;
    if (calls === 1) {
      return { ok: true, json: async () => ({ content: [{ type: 'tool_use', id: 't1', name: 'regex_match', input: { pattern: '.', flags: 'g', text } }], stop_reason: 'tool_use' }) };
    }
    // Second turn: capture what got sent back (should contain the truncated result), then finalize.
    secondRequestMessages = JSON.parse(init.body).messages;
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }) };
  };
  const r = await runAgentTurn({
    agent: { provider: 'anthropic', model: 'claude', tools: ['regex_match'] },
    userMessage: 'go', fetchImpl, apiKey: 'k', maxIterations: 4,
    compact: { maxTokens: 1e9, toolResultMaxChars: 500 },
  });
  assert.equal(r.stoppedBy, 'final');
  assert.ok(secondRequestMessages, 'second request must have been made');
  // Assert on the tool_result block specifically — the precise thing L1 shrinks.
  const toolResultMsg = secondRequestMessages.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
  assert.ok(toolResultMsg, 'the tool_result must be present in the resend');
  const block = toolResultMsg.content.find((b) => b.type === 'tool_result');
  assert.ok(block.content.length < 700, 'the oversized tool_result must have been truncated to ~500 chars');
  assert.match(block.content, /elided|truncat/i);
});

// ---- DEFECT B: per-run budget ceiling ----

test('runAgentTurn stops with stoppedBy=budget_exceeded when maxTokens ceiling is crossed', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    // Every turn: keep asking for a tool so the loop would run forever without a budget.
    return { ok: true, json: async () => ({ content: [{ type: 'tool_use', id: `t${calls}`, name: 'regex_match', input: { pattern: 'x', text: 'x' } }], stop_reason: 'tool_use', usage: { input_tokens: 5000, output_tokens: 5000 } }) };
  };
  const r = await runAgentTurn({
    agent: { provider: 'anthropic', model: 'claude', tools: ['regex_match'] },
    userMessage: 'go', fetchImpl, apiKey: 'k', maxIterations: 50,
    budget: { maxTokens: 12000 },
  });
  assert.equal(r.stoppedBy, 'budget_exceeded', 'the loop must stop on the token ceiling');
  assert.ok(calls < 50, 'the loop must not run to maxIterations');
  assert.ok(r.usage && r.usage.inputTokens + r.usage.outputTokens >= 12000, 'partial usage is reported');
});

test('runAgentTurn stops with budget_exceeded on the maxCostUsd ceiling', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) {
      return { ok: true, json: async () => ({ content: [{ type: 'tool_use', id: `t${calls}`, name: 'regex_match', input: { pattern: 'x', text: 'x' } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } }) };
    }
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }) };
  };
  // Anthropic parseResponse reports no totalCostUsd, so accumulated cost stays 0.
  // A maxCostUsd:0 ceiling with the strict ">" comparison must NOT trip (0 is not
  // > 0) — this guards against an off-by-one that would stop every turn.
  const r = await runAgentTurn({
    agent: { provider: 'anthropic', model: 'claude', tools: ['regex_match'] },
    userMessage: 'go', fetchImpl, apiKey: 'k', maxIterations: 5,
    budget: { maxCostUsd: 0 },
  });
  // With cost staying 0 and ceiling 0, the strict ">" comparison must NOT trip (0 is not > 0),
  // so this behaves like today. Guards against an off-by-one that would stop every turn.
  assert.notEqual(r.stoppedBy, 'budget_exceeded');
});

// ---- Regression guard: NEITHER option => unchanged behavior ----

test('regression: without compact/budget, a normal tool loop finishes as final (unchanged)', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) {
      return { ok: true, json: async () => ({ content: [{ type: 'tool_use', id: 't1', name: 'regex_match', input: { pattern: 'x', text: 'x' } }], stop_reason: 'tool_use' }) };
    }
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }) };
  };
  const r = await runAgentTurn({
    agent: { provider: 'anthropic', model: 'claude', tools: ['regex_match'] },
    userMessage: 'go', fetchImpl, apiKey: 'k', maxIterations: 4,
  });
  assert.equal(r.stoppedBy, 'final');
  assert.equal(r.text, 'done');
});
