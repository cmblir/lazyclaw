// f-agentic-repl — Group 1: agentic REPL + plan mode.
//
// Pins the routing contract for makeRunTurn (tui/run_turn.mjs) and the
// /agentic + /plan slash toggles (tui/slash_dispatcher.mjs):
//   (a) cfg.chat.agentic=false → streaming via prov.sendMessage (preserved);
//   (b) cfg.chat.agentic=true  → routes through runAgentTurn with a synthetic
//       chat agent record carrying the configured tool whitelist;
//   (c) plan mode intersects the whitelist to a read-only set (no bash/write);
//   (d) /agentic and /plan slash handlers toggle + persist cfg.chat.*.
//
// runAgentTurn is injected via ctx (ctx.runAgentTurnImpl) so the unit test
// stubs it without a real provider round-trip. The default streaming path is
// also stubbed (a mock prov.sendMessage generator).

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRunTurn } from '../tui/run_turn.mjs';
import { dispatchSlash } from '../tui/slash_dispatcher.mjs';
import {
  chatAgenticGet, chatPlanModeGet, chatToolsGet, effectiveChatTools,
} from '../config_features.mjs';

function mockProv(observe = {}) {
  return {
    name: 'mock',
    async *sendMessage(messages, opts = {}) {
      observe.streamCalled = (observe.streamCalled || 0) + 1;
      observe.lastMessages = messages.map((m) => ({ ...m }));
      yield 'streamed-reply';
    },
  };
}

function makeRunTurnCtx({ cfg, provider, messages = [], runAgentTurnImpl, approve } = {}) {
  return {
    cfg,
    cfgDir: '/tmp/lc-agentic-test-nonexistent',
    sandboxSpec: null,
    syntheticChatSessionId: 'chat-agentic-1',
    getMessages: () => messages,
    getProv: () => provider,
    getActiveProvName: () => 'mock',
    getActiveModel: () => 'mock-m',
    getSessionId: () => null,
    persistTurn: () => {},
    accumulateUsage: () => {},
    resolveAuthKey: () => '',
    // agentic wiring (consumed by run_turn with safe fallbacks)
    runAgentTurnImpl,
    approve,
  };
}

test('(a) agentic OFF routes to prov.sendMessage (streaming preserved)', async () => {
  const observe = {};
  const agenticObserve = {};
  const messages = [];
  const ctx = makeRunTurnCtx({
    cfg: { provider: 'mock', model: 'mock-m' }, // no chat.agentic
    provider: mockProv(observe),
    messages,
    runAgentTurnImpl: async () => { agenticObserve.called = true; return { text: 'x', stoppedBy: 'final', toolCalls: [] }; },
  });
  const writes = [];
  const runTurn = makeRunTurn({ ctx, writeFn: (c) => writes.push(c) });
  await runTurn('hi', new AbortController().signal);
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(observe.streamCalled, 1, 'streaming path must be used when agentic is OFF');
  assert.ok(!agenticObserve.called, 'runAgentTurn must NOT be called when agentic is OFF');
  assert.ok(writes.join('').includes('streamed-reply'));
});

test('(b) agentic ON routes to runAgentTurn with a chat agent record carrying configured tools', async () => {
  const observe = {};
  const captured = {};
  const messages = [{ role: 'system', content: 'you are a helper' }];
  const ctx = makeRunTurnCtx({
    cfg: { provider: 'mock', model: 'mock-m', chat: { agentic: true, tools: ['read', 'grep', 'bash'] } },
    provider: mockProv(observe),
    messages,
    runAgentTurnImpl: async (args) => {
      captured.args = args;
      return { text: 'agentic answer', stoppedBy: 'final', toolCalls: [] };
    },
  });
  const writes = [];
  const runTurn = makeRunTurn({ ctx, writeFn: (c) => writes.push(c) });
  await runTurn('do a thing', new AbortController().signal);
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(!observe.streamCalled, 'streaming path must NOT be used when agentic is ON');
  assert.ok(captured.args, 'runAgentTurn must be called when agentic is ON');
  const agent = captured.args.agent;
  assert.equal(agent.name, 'chat');
  assert.equal(agent.provider, 'mock');
  assert.equal(agent.model, 'mock-m');
  assert.equal(agent.role, 'you are a helper', 'system message threads into agent.role');
  assert.deepEqual(agent.tools, ['read', 'grep', 'bash'], 'configured whitelist threads into agent.tools');
  assert.equal(captured.args.userMessage, 'do a thing');
  assert.ok(writes.join('').includes('agentic answer'), 'final answer must be rendered');
});

test('(b2) agentic ON applies default-on confinement (sandbox spec threaded to runAgentTurn)', async () => {
  const captured = {};
  const ctx = makeRunTurnCtx({
    cfg: { provider: 'mock', model: 'mock-m', chat: { agentic: true } },
    provider: mockProv({}),
    messages: [{ role: 'system', content: 's' }],
    runAgentTurnImpl: async (args) => { captured.args = args; return { text: 'a', stoppedBy: 'final', toolCalls: [] }; },
  });
  await makeRunTurn({ ctx, writeFn: () => {} })('hi', new AbortController().signal);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(captured.args.sandbox, 'a default sandbox spec must be threaded when no --sandbox is given');
  assert.equal(captured.args.sandbox.kind, 'local');
  assert.equal(captured.args.sandbox.confiner, 'auto');
});

test('(b3) cfg.sandbox.confine=false opts out of default-on confinement (no sandbox)', async () => {
  const captured = {};
  const ctx = makeRunTurnCtx({
    cfg: { provider: 'mock', model: 'mock-m', chat: { agentic: true }, sandbox: { confine: false } },
    provider: mockProv({}),
    messages: [{ role: 'system', content: 's' }],
    runAgentTurnImpl: async (args) => { captured.args = args; return { text: 'a', stoppedBy: 'final', toolCalls: [] }; },
  });
  await makeRunTurn({ ctx, writeFn: () => {} })('hi', new AbortController().signal);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(captured.args.sandbox, null, 'confine:false must disable confinement');
});

test('(c) plan mode intersects tools to read-only (no bash/write in agent record)', async () => {
  const captured = {};
  const messages = [];
  const ctx = makeRunTurnCtx({
    cfg: { provider: 'mock', model: 'mock-m', chat: { agentic: true, planMode: true, tools: ['read', 'grep', 'bash', 'write'] } },
    provider: mockProv({}),
    messages,
    runAgentTurnImpl: async (args) => { captured.args = args; return { text: 'plan', stoppedBy: 'final', toolCalls: [] }; },
  });
  const runTurn = makeRunTurn({ ctx, writeFn: () => {} });
  await runTurn('plan it', new AbortController().signal);
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(captured.args, 'plan mode routes through runAgentTurn');
  const tools = captured.args.agent.tools;
  assert.ok(!tools.includes('bash'), 'bash must be dropped in plan mode');
  assert.ok(!tools.includes('write'), 'write must be dropped in plan mode');
  assert.ok(tools.includes('read'), 'read survives the read-only intersection');
  assert.ok(tools.includes('grep'), 'grep survives the read-only intersection');
});

test('effectiveChatTools: default whitelist + plan-mode read-only intersection', () => {
  // default (no cfg.chat.tools) → read-only safe set
  assert.deepEqual(chatToolsGet({}), ['read', 'grep', 'skill_view']);
  // plan mode drops sensitive tools from a configured list
  const tools = effectiveChatTools({ chat: { tools: ['read', 'grep', 'bash', 'write', 'skill_view'] } }, { planMode: true });
  assert.ok(!tools.includes('bash'));
  assert.ok(!tools.includes('write'));
  assert.deepEqual(tools, ['read', 'grep', 'skill_view']);
});

test('(d) /agentic toggles + persists cfg.chat.agentic', async () => {
  const cfg = { provider: 'mock' };
  const persisted = [];
  const ctx = {
    cfg, cfgDir: '/tmp/x',
    readConfig: () => cfg,
    writeConfig: (c) => { persisted.push(JSON.parse(JSON.stringify(c))); },
  };
  assert.equal(chatAgenticGet(cfg), false);

  const on = await dispatchSlash('/agentic', 'on', ctx, () => {});
  assert.match(on, /on/i);
  assert.equal(chatAgenticGet(cfg), true, 'in-memory cfg mirrors the toggle');
  assert.ok(persisted.length >= 1, 'writeConfig persisted the toggle');
  assert.equal(persisted[persisted.length - 1].chat.agentic, true);

  const off = await dispatchSlash('/agentic', 'off', ctx, () => {});
  assert.match(off, /off/i);
  assert.equal(chatAgenticGet(cfg), false);
});

test('(d) /plan toggles + persists cfg.chat.planMode', async () => {
  const cfg = { provider: 'mock' };
  const ctx = { cfg, cfgDir: '/tmp/x', readConfig: () => cfg, writeConfig: () => {} };
  assert.equal(chatPlanModeGet(cfg), false);

  const on = await dispatchSlash('/plan', 'on', ctx, () => {});
  assert.match(on, /on/i);
  assert.equal(chatPlanModeGet(cfg), true);

  const off = await dispatchSlash('/plan', 'off', ctx, () => {});
  assert.match(off, /off/i);
  assert.equal(chatPlanModeGet(cfg), false);
});
