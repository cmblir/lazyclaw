// Group B / C10 — MAS transcript-as-messages refactor.
//
// Before: buildTurnContext returned { system, user } where `user` was
// ONE stringified blob containing the entire transcript. Every router
// pass mutated that blob, so the prompt cache + KV cache never had a
// stable prefix to lock onto — even though 95% of the prefix was
// byte-identical across passes.
//
// After: buildTurnContext also returns `history`, an array of
// {role, content} entries reflecting prior turns. runTaskTurn passes
// it through as the runAgentTurn history, leaving userMessage empty.
// This gives Anthropic a stable cacheable prefix across iterations.
//
// Assertions:
//   - history is an array of length === task.turns.length + 2
//     (the kickoff task spec at index 0 + each prior turn + a final
//     "your turn" marker).
//   - The speaker's own prior turns appear as role:'assistant'.
//   - Teammate turns appear as role:'user' with a `[FROM x]` prefix.
//   - Across 3 router iterations of the SAME task with no new turns
//     between calls, the first N entries of body.messages are byte-
//     identical so Anthropic's cache can lock onto them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildTurnContext, runTaskTurn } from '../mas/mention_router.mjs';
import { registerAgent } from '../agents.mjs';
import { registerTeam } from '../teams.mjs';
import { registerTask, appendTurn as appendTaskTurn } from '../tasks.mjs';

function tmpCfg(prefix = 'lc-c10-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('C10 — buildTurnContext.history is an array shaped as [kickoff, ...turns, your-turn]', () => {
  const cfg = tmpCfg();
  const turns = [
    { agent: 'user', text: 'do the thing' },
    { agent: 'alice', text: 'on it' },
    { agent: 'bob', text: 'reviewing' },
  ];
  const ctx = buildTurnContext({
    task: { id: 't1', title: 'feature X', description: 'spec', turns },
    team: { name: 'team1', displayName: 'Team 1' },
    agent: 'alice',
    agentRecord: { name: 'alice', displayName: 'Alice', role: 'R' },
    teammates: ['bob'],
    configDir: cfg,
  });
  assert.ok(Array.isArray(ctx.history), 'ctx.history must be an array');
  // kickoff + 3 prior turns + final "your turn" = 5
  assert.equal(ctx.history.length, turns.length + 2,
    `expected history of length ${turns.length + 2}, got ${ctx.history.length}`);
  // First entry: kickoff with task spec.
  assert.equal(ctx.history[0].role, 'user');
  assert.ok(ctx.history[0].content.includes('feature X'),
    `kickoff must include task title, got: ${ctx.history[0].content}`);
  // Last entry: "your turn" marker.
  assert.equal(ctx.history[ctx.history.length - 1].role, 'user');
  assert.ok(ctx.history[ctx.history.length - 1].content.includes('Your turn (as alice)'),
    `final marker must name the speaker, got: ${ctx.history[ctx.history.length - 1].content}`);
});

test('C10 — agent\'s own prior turns appear as role:"assistant"; teammate turns get [FROM x] prefix', () => {
  const cfg = tmpCfg();
  const turns = [
    { agent: 'user', text: 'kickoff' },
    { agent: 'alice', text: 'my prior turn' },
    { agent: 'bob', text: 'teammate said this' },
  ];
  const ctx = buildTurnContext({
    task: { id: 't1', title: 'T', description: '', turns },
    team: { name: 'team1', displayName: 'Team 1' },
    agent: 'alice',
    agentRecord: { name: 'alice', displayName: 'Alice', role: 'R' },
    teammates: ['bob'],
    configDir: cfg,
  });
  // history = [kickoff, user-turn, alice-assistant, bob-user, your-turn]
  const userTurn = ctx.history.find(h => h.content === 'kickoff');
  assert.ok(userTurn, 'plain "kickoff" user turn must be present');
  assert.equal(userTurn.role, 'user');
  const aliceTurn = ctx.history.find(h => h.content === 'my prior turn');
  assert.ok(aliceTurn, 'alice\'s prior turn must be present');
  assert.equal(aliceTurn.role, 'assistant',
    'speaker\'s own prior turns must appear as role:assistant');
  const bobTurn = ctx.history.find(h => h.content && h.content.startsWith('[FROM bob]'));
  assert.ok(bobTurn, 'teammate turn must be prefixed with [FROM bob]');
  assert.equal(bobTurn.role, 'user',
    'teammate turns must appear as role:user (model treats them as another speaker)');
  assert.ok(bobTurn.content.includes('teammate said this'));
});

test('C10 — runTaskTurn ships ctx.history to the Anthropic adapter (not a single user blob)', async () => {
  // We drive 1 router pass through a real anthropic fakeFetch and
  // inspect body.messages to confirm history landed as multiple
  // messages, not one giant user message containing the transcript.
  const cfg = tmpCfg();
  registerAgent({ name: 'planner', provider: 'anthropic', model: 'claude-opus-4-7', role: 'R', tools: [] }, cfg);
  registerTeam({ name: 'team-c10', agents: ['planner'], lead: 'planner' }, cfg);
  const task = registerTask({ id: 't_20260605_abcdef', title: 'check', team: 'team-c10' }, cfg);
  // Seed a prior turn so history isn't just kickoff + marker.
  appendTaskTurn(task.id, { agent: 'user', text: 'EARLIER_TURN', ts: new Date().toISOString() }, cfg);

  const observed = [];
  const fetchImpl = async (_url, init) => {
    observed.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'done [[TASK_DONE]]' }], stop_reason: 'end_turn' }),
    };
  };

  await runTaskTurn({
    task: { ...task, turns: [{ agent: 'user', text: 'EARLIER_TURN' }] },
    team: { name: 'team-c10', displayName: 'Team C10', agents: ['planner'], lead: 'planner' },
    agentsById: { planner: { name: 'planner', displayName: 'Planner', role: 'R', provider: 'anthropic', model: 'claude-opus-4-7', tools: [] } },
    configDir: cfg,
    apiKey: 'sk',
    fetchImpl,
  });

  assert.ok(observed.length >= 1, 'expected at least one provider round-trip');
  const msgs = observed[0].messages;
  // The history should be: [kickoff, user-EARLIER, your-turn]
  assert.ok(msgs.length >= 3,
    `expected ≥3 messages (kickoff + earlier turn + your-turn), got ${msgs.length}`);
  // The "EARLIER_TURN" should appear as its OWN message (not embedded
  // in a giant blob). We allow it to be a string OR an array of blocks
  // because the cache_control marker we attach in agent_turn lifts
  // some content into a block array — but for the FIRST router pass
  // (1 iteration only) the original strings should still be raw.
  const earlier = msgs.find(m => {
    if (typeof m.content === 'string') return m.content === 'EARLIER_TURN';
    if (Array.isArray(m.content)) return m.content.some(b => b.text === 'EARLIER_TURN');
    return false;
  });
  assert.ok(earlier, `expected a standalone message for EARLIER_TURN, got: ${JSON.stringify(msgs.map(m => ({ role: m.role, c: typeof m.content === 'string' ? m.content.slice(0, 40) : '(array)' })))}`);
});

test('C10 — across 3 router calls on the same task state, the FIRST kickoff+turn messages are byte-identical (stable cacheable prefix)', () => {
  // Pure unit test on buildTurnContext — independent invocations with
  // the same task state must produce the same history entries so the
  // model's cache key prefix matches across calls.
  const cfg = tmpCfg();
  const taskState = {
    id: 't1', title: 'stable', description: 'fixed',
    turns: [
      { agent: 'user', text: 'kickoff text' },
      { agent: 'planner', text: 'plan output' },
    ],
  };
  const args = {
    task: taskState,
    team: { name: 'tm', displayName: 'TM' },
    agent: 'planner',
    agentRecord: { name: 'planner', displayName: 'Planner', role: 'R' },
    teammates: [],
    configDir: cfg,
  };
  const a = buildTurnContext(args);
  const b = buildTurnContext(args);
  const c = buildTurnContext(args);
  // For the same task state, history entries must be byte-identical
  // up to and including the "your turn" marker.
  assert.equal(JSON.stringify(a.history), JSON.stringify(b.history),
    'history must be byte-identical across calls with the same state');
  assert.equal(JSON.stringify(b.history), JSON.stringify(c.history),
    'history must be byte-identical across calls with the same state');
});
