// Phase 1b — subagent isolation. spawn_subagent runs a FRESH runAgentTurn
// with an EMPTY history (the parent transcript is NOT passed in) under a
// per-subagent tool ALLOWLIST, and returns ONLY the distilled final text
// plus a tiny usage summary — never the subagent's intermediate transcript.
//
// These are additive tests: the existing delegation tools (task_spawn,
// delegate) and the default runAgentTurn contract are untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as del from '../mas/tools/delegation.mjs';
import * as registry from '../mas/tools/registry.mjs';
import { resolveToolset } from '../mas/toolsets.mjs';

// ── registration / wiring ───────────────────────────────────────────────
test('spawn_subagent is registered and sensitive-gated like other delegation tools', () => {
  const t = registry.lookup('spawn_subagent');
  assert.ok(t, 'spawn_subagent must be registered');
  assert.equal(t.sensitive, true, 'must be sensitive like task_spawn/delegate');
  assert.equal(t.category, 'agents');
});

test('spawn_subagent is included in the agentic toolset (additive)', () => {
  const tools = resolveToolset('agentic');
  assert.ok(tools.includes('spawn_subagent'), 'agentic toolset must include spawn_subagent');
  // existing members remain (additive, not a replacement)
  assert.ok(tools.includes('task_spawn'));
  assert.ok(tools.includes('delegate'));
});

// ── (a) isolated context — no parent history leaks in ───────────────────
test('spawn_subagent runs an isolated turn — parent history is NOT passed in', async () => {
  let received = null;
  del.__setTurnRunner(async (job) => {
    received = job;
    return { text: 'distilled conclusion', stoppedBy: 'final', iterations: 2, usage: { inputTokens: 10, outputTokens: 5 }, toolCalls: [{ name: 'read', ok: true }] };
  });
  const t = del.TOOLS.find((x) => x.name === 'spawn_subagent');
  const parentHistory = [{ role: 'user', content: 'SECRET PARENT TURN' }, { role: 'assistant', content: 'parent reply' }];
  const r = await t.exec(
    { objective: 'scan the logs and summarize' },
    { agent: { name: 'planner', provider: 'anthropic', model: 'claude-x' }, history: parentHistory, configDir: '/tmp/x' },
  );
  del.__setTurnRunner(null);

  assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
  // Only the distilled final text is surfaced.
  assert.equal(r.text, 'distilled conclusion');
  // No intermediate transcript / toolCalls leak into the returned payload.
  assert.equal(r.toolCalls, undefined, 'subagent transcript must NOT be returned');
  // A tiny usage summary is included.
  assert.ok(r.usage && typeof r.usage === 'object');
  assert.equal(r.usage.inputTokens, 10);

  // The runner MUST have received a fresh, EMPTY history — the parent turns
  // must not be threaded in.
  assert.ok(received, 'runner was never invoked');
  const seenHistory = received.history;
  assert.ok(seenHistory === undefined || (Array.isArray(seenHistory) && seenHistory.length === 0),
    `subagent must start with empty history, got ${JSON.stringify(seenHistory)}`);
  // The objective becomes the subagent's user message.
  assert.equal(received.userMessage, 'scan the logs and summarize');
  // Provider/model inherited from the parent agent by default.
  assert.equal(received.agent.provider, 'anthropic');
  assert.equal(received.agent.model, 'claude-x');
});

// ── (b) tool allowlist is enforced ──────────────────────────────────────
test('spawn_subagent enforces a per-subagent tool allowlist — non-listed tools are unavailable', async () => {
  let received = null;
  del.__setTurnRunner(async (job) => { received = job; return { text: 'ok', stoppedBy: 'final', iterations: 1 }; });
  const t = del.TOOLS.find((x) => x.name === 'spawn_subagent');
  await t.exec(
    { objective: 'read one file', tools: ['read', 'grep'] },
    { agent: { name: 'planner', provider: 'anthropic', model: 'm' } },
  );
  del.__setTurnRunner(null);
  // The spawned agent record's .tools IS the allowlist (listToolSchemas +
  // runTool both filter by agent.tools, so a tool not here is unavailable).
  assert.deepEqual(received.agent.tools, ['read', 'grep']);
  assert.ok(!received.agent.tools.includes('bash'), 'bash must NOT be available to the subagent');
  assert.ok(!received.agent.tools.includes('write'), 'write must NOT be available to the subagent');
});

test('spawn_subagent defaults to a safe read-only allowlist when tools omitted', async () => {
  let received = null;
  del.__setTurnRunner(async (job) => { received = job; return { text: 'ok', stoppedBy: 'final', iterations: 1 }; });
  const t = del.TOOLS.find((x) => x.name === 'spawn_subagent');
  await t.exec({ objective: 'explore' }, { agent: { name: 'p', provider: 'anthropic', model: 'm' } });
  del.__setTurnRunner(null);
  assert.ok(Array.isArray(received.agent.tools) && received.agent.tools.length > 0);
  // read-only subset — no mutating/exec tools.
  assert.ok(!received.agent.tools.includes('bash'));
  assert.ok(!received.agent.tools.includes('write'));
  assert.ok(!received.agent.tools.includes('edit'));
  // must include read-only staples.
  assert.ok(received.agent.tools.includes('read'));
  assert.ok(received.agent.tools.includes('grep'));
});

// ── (c) budget cap stops a runaway subagent ─────────────────────────────
test('spawn_subagent forwards a budget cap to the isolated turn', async () => {
  let received = null;
  del.__setTurnRunner(async (job) => {
    received = job;
    // Simulate a runner that reports it stopped on budget.
    return { text: 'partial', stoppedBy: 'budget_exceeded', iterations: 3, usage: { inputTokens: 999 } };
  });
  const t = del.TOOLS.find((x) => x.name === 'spawn_subagent');
  const r = await t.exec(
    { objective: 'runaway', budget: { maxTokens: 100 } },
    { agent: { name: 'p', provider: 'anthropic', model: 'm' } },
  );
  del.__setTurnRunner(null);
  // The budget must be threaded through so runAgentTurn can cap the run.
  assert.deepEqual(received.budget, { maxTokens: 100 });
  // And the caller sees how the subagent stopped.
  assert.equal(r.ok, true);
  assert.equal(r.stoppedBy, 'budget_exceeded');
});

test('spawn_subagent caps iterations by default (maxIterations forwarded)', async () => {
  let received = null;
  del.__setTurnRunner(async (job) => { received = job; return { text: 'x', stoppedBy: 'final', iterations: 1 }; });
  const t = del.TOOLS.find((x) => x.name === 'spawn_subagent');
  await t.exec({ objective: 'go' }, { agent: { name: 'p', provider: 'anthropic', model: 'm' } });
  del.__setTurnRunner(null);
  assert.equal(typeof received.maxIterations, 'number');
  assert.ok(received.maxIterations > 0);
});

// ── error handling ───────────────────────────────────────────────────────
test('spawn_subagent requires an objective (clean error, no runner call)', async () => {
  let called = false;
  del.__setTurnRunner(async () => { called = true; return { text: '' }; });
  const t = del.TOOLS.find((x) => x.name === 'spawn_subagent');
  const r = await t.exec({}, { agent: { name: 'p', provider: 'anthropic', model: 'm' } });
  del.__setTurnRunner(null);
  assert.equal(r.ok, false);
  assert.match(r.error, /objective/);
  assert.equal(called, false);
});

test('spawn_subagent inherits provider/model but honors explicit overrides', async () => {
  let received = null;
  del.__setTurnRunner(async (job) => { received = job; return { text: 'ok', stoppedBy: 'final', iterations: 1 }; });
  const t = del.TOOLS.find((x) => x.name === 'spawn_subagent');
  await t.exec(
    { objective: 'go', provider: 'openai', model: 'gpt-x' },
    { agent: { name: 'p', provider: 'anthropic', model: 'claude-x' } },
  );
  del.__setTurnRunner(null);
  assert.equal(received.agent.provider, 'openai');
  assert.equal(received.agent.model, 'gpt-x');
});
