// Group B / C8 + C9 — Anthropic prompt caching wired through the chat
// path (providers/anthropic.mjs) AND the tool-use adapter
// (providers/tool_use/anthropic.mjs).
//
// What we assert:
//   - C8 — sendMessage with cache:true lifts body.system into a
//          cache_control:ephemeral text block; default (no cache opt)
//          keeps it as a plain string for byte-stability with
//          phase 6 / phase 24 existing tests.
//   - C8 — sendMessage with systemStatic + systemVolatile sends a
//          two-block system: static carries cache_control, volatile
//          does NOT.
//   - C9 — callOnce with cache:true lifts body.system AND attaches
//          cache_control to the LAST entry in body.tools, plus sets
//          the anthropic-beta header.
//   - C9 — agent_turn tool-loop with cache:true marks the previously
//          appended assistant + tool_result content blocks with
//          cache_control so the prompt-cache breakpoint advances per
//          loop iteration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicProvider } from '../providers/anthropic.mjs';
import { callOnce } from '../providers/tool_use/anthropic.mjs';
import { runAgentTurn } from '../mas/agent_turn.mjs';

// SSE fake that records the body and returns an immediate message_stop
// so the streaming iterator drains cleanly.
function fakeStreamingFetch(observe) {
  return async (_url, init) => {
    observe.push({ body: JSON.parse(init.body), headers: init.headers });
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(
            'event: message_stop\ndata: {"type":"message_stop"}\n\n'));
          c.close();
        },
      }),
    };
  };
}

// Tool-use fake — returns a final text JSON envelope so callOnce
// resolves with kind:'final'.
function fakeJsonFetch(observe, body = { content: [{ type: 'text', text: 'ok' }] }) {
  return async (_url, init) => {
    observe.push({ body: JSON.parse(init.body), headers: init.headers });
    return { ok: true, json: async () => body };
  };
}

test('C8 — sendMessage with cache:true lifts body.system into a cache_control:ephemeral block', async () => {
  const observe = [];
  for await (const _c of anthropicProvider.sendMessage(
    [{ role: 'user', content: 'q' }],
    { apiKey: 'sk', model: 'claude-opus-4-7', fetch: fakeStreamingFetch(observe), system: 'STABLE_PREFIX', cache: true },
  )) { /* drain */ }
  assert.ok(Array.isArray(observe[0].body.system),
    'system must be lifted to an array of blocks when cache:true');
  assert.equal(observe[0].body.system[0].type, 'text');
  assert.equal(observe[0].body.system[0].text, 'STABLE_PREFIX');
  assert.deepEqual(observe[0].body.system[0].cache_control, { type: 'ephemeral' });
});

test('C8 — sendMessage with no cache opt sends body.system as plain string (back-compat)', async () => {
  const observe = [];
  for await (const _c of anthropicProvider.sendMessage(
    [{ role: 'user', content: 'q' }],
    { apiKey: 'sk', model: 'claude-opus-4-7', fetch: fakeStreamingFetch(observe), system: 'PLAIN' },
  )) { /* drain */ }
  assert.equal(observe[0].body.system, 'PLAIN',
    'default (no cache opt) must keep system as a plain string for byte-stability');
});

test('C8 — sendMessage with systemStatic + systemVolatile builds a 2-block system; only static is cached', async () => {
  const observe = [];
  for await (const _c of anthropicProvider.sendMessage(
    [{ role: 'user', content: 'q' }],
    {
      apiKey: 'sk', model: 'claude-opus-4-7', fetch: fakeStreamingFetch(observe),
      systemStatic: 'WORKSPACE_SOUL_AND_SKILLS_INDEX',
      systemVolatile: 'TURN_SPECIFIC_HINT',
    },
  )) { /* drain */ }
  const sys = observe[0].body.system;
  assert.ok(Array.isArray(sys), 'system must be a multi-block array');
  assert.equal(sys.length, 2, 'expected exactly 2 blocks: static + volatile');
  assert.equal(sys[0].text, 'WORKSPACE_SOUL_AND_SKILLS_INDEX');
  assert.deepEqual(sys[0].cache_control, { type: 'ephemeral' });
  assert.equal(sys[1].text, 'TURN_SPECIFIC_HINT');
  assert.equal(sys[1].cache_control, undefined,
    'volatile block must NOT carry cache_control');
});

test('C8 — sendMessage with only systemStatic still sends a cached static block (no volatile slot)', async () => {
  const observe = [];
  for await (const _c of anthropicProvider.sendMessage(
    [{ role: 'user', content: 'q' }],
    {
      apiKey: 'sk', model: 'claude-opus-4-7', fetch: fakeStreamingFetch(observe),
      systemStatic: 'STATIC_ONLY',
    },
  )) { /* drain */ }
  const sys = observe[0].body.system;
  assert.ok(Array.isArray(sys));
  assert.equal(sys.length, 1);
  assert.equal(sys[0].text, 'STATIC_ONLY');
  assert.deepEqual(sys[0].cache_control, { type: 'ephemeral' });
});

test('C9 — callOnce with cache:true attaches cache_control to the LAST tool and to system', async () => {
  const observe = [];
  await callOnce({
    messages: [{ role: 'user', content: 'q' }],
    tools: [
      { name: 'a', description: 'A', input_schema: { type: 'object' } },
      { name: 'b', description: 'B', input_schema: { type: 'object' } },
      { name: 'c', description: 'C', input_schema: { type: 'object' } },
    ],
    model: 'claude-opus-4-7',
    apiKey: 'sk',
    system: 'TOOL_USE_SYS',
    fetchImpl: fakeJsonFetch(observe),
    cache: true,
  });
  const body = observe[0].body;
  assert.ok(Array.isArray(body.system));
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(body.tools.length, 3);
  assert.equal(body.tools[0].cache_control, undefined);
  assert.equal(body.tools[1].cache_control, undefined);
  assert.deepEqual(body.tools[2].cache_control, { type: 'ephemeral' });
});

test('C9 — callOnce with cache:true sets anthropic-beta prompt-caching header', async () => {
  const observe = [];
  await callOnce({
    messages: [{ role: 'user', content: 'q' }],
    tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
    model: 'claude-opus-4-7',
    apiKey: 'sk',
    system: 'sys',
    fetchImpl: fakeJsonFetch(observe),
    cache: true,
  });
  assert.equal(observe[0].headers['anthropic-beta'], 'prompt-caching-2024-07-31');
});

test('C9 — callOnce with cache:false (default) does NOT set the beta header and keeps body.system as a string', async () => {
  const observe = [];
  await callOnce({
    messages: [{ role: 'user', content: 'q' }],
    tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
    model: 'claude-opus-4-7',
    apiKey: 'sk',
    system: 'sys',
    fetchImpl: fakeJsonFetch(observe),
  });
  assert.equal(observe[0].headers['anthropic-beta'], undefined);
  assert.equal(observe[0].body.system, 'sys');
  assert.equal(observe[0].body.tools[0].cache_control, undefined);
});

test('C9 — callOnce does not mutate the caller-owned tools array even when cache:true', async () => {
  const observe = [];
  const tools = [
    { name: 'a', description: 'A', input_schema: { type: 'object' } },
    { name: 'b', description: 'B', input_schema: { type: 'object' } },
  ];
  await callOnce({
    messages: [{ role: 'user', content: 'q' }],
    tools,
    model: 'claude-opus-4-7',
    apiKey: 'sk',
    system: 'sys',
    fetchImpl: fakeJsonFetch(observe),
    cache: true,
  });
  assert.equal(tools[0].cache_control, undefined,
    'caller-owned tools[0] must not be mutated');
  assert.equal(tools[1].cache_control, undefined,
    'caller-owned tools[1] (last) must not be mutated either');
});

test('C9 — runAgentTurn with cache:true marks the freshly-appended assistant + tool_result content with cache_control across iterations', async () => {
  // Drive the loop through TWO iterations: turn 1 → tool_use,
  // turn 2 → final text. After iteration 1 the messages array must
  // have an assistant block (the tool_use envelope) carrying
  // cache_control on its last content block, AND a tool_result user
  // block also carrying cache_control. The 2nd request's body.messages
  // is what we inspect.
  const observe = [];
  let callIdx = 0;
  const fetchImpl = async (_url, init) => {
    observe.push({ body: JSON.parse(init.body), headers: init.headers });
    callIdx++;
    if (callIdx === 1) {
      return { ok: true, json: async () => ({
        content: [
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'x' } },
        ],
        stop_reason: 'tool_use',
      })};
    }
    return { ok: true, json: async () => ({
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
    })};
  };
  // The bare-minimum tool entry that runs without disk access: a stub
  // that we register via the runner's registry isn't worth setting up
  // here. Instead we use `read` and tolerate a tool error — the loop
  // continues and we still get to inspect the 2nd request's messages.
  await runAgentTurn({
    agent: { name: 'cache-test', provider: 'anthropic', model: 'claude-opus-4-7', role: 'R', tools: ['read'] },
    userMessage: 'investigate',
    apiKey: 'sk',
    fetchImpl,
    cache: true,
    configDir: undefined,  // skip trajectory side effects
  });
  assert.equal(observe.length, 2, 'expected 2 round-trips (tool_use then final)');

  // Iteration 2 request: messages[] now includes the assistant turn
  // (index = last - 1) AND the tool_result user turn (index = last).
  const msgs = observe[1].body.messages;
  assert.ok(msgs.length >= 3, `expected at least 3 messages, got ${msgs.length}`);
  const assistantTurn = msgs[msgs.length - 2];
  const toolResultTurn = msgs[msgs.length - 1];
  assert.equal(assistantTurn.role, 'assistant');
  assert.equal(toolResultTurn.role, 'user');
  // The LAST content block in each should carry cache_control.
  const lastAssistantBlock = assistantTurn.content[assistantTurn.content.length - 1];
  const lastToolResultBlock = toolResultTurn.content[toolResultTurn.content.length - 1];
  assert.deepEqual(lastAssistantBlock.cache_control, { type: 'ephemeral' },
    'last assistant content block must carry cache_control after iteration 1');
  assert.deepEqual(lastToolResultBlock.cache_control, { type: 'ephemeral' },
    'last tool_result content block must carry cache_control after iteration 1');
});

test('C9 — runAgentTurn with cache:false (default) leaves messages cache_control-free', async () => {
  const observe = [];
  let callIdx = 0;
  const fetchImpl = async (_url, init) => {
    observe.push({ body: JSON.parse(init.body) });
    callIdx++;
    if (callIdx === 1) {
      return { ok: true, json: async () => ({
        content: [
          { type: 'tool_use', id: 'toolu_x', name: 'read', input: { path: 'x' } },
        ],
        stop_reason: 'tool_use',
      })};
    }
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' })};
  };
  await runAgentTurn({
    agent: { name: 'no-cache', provider: 'anthropic', model: 'claude-opus-4-7', role: 'R', tools: ['read'] },
    userMessage: 'investigate',
    apiKey: 'sk',
    fetchImpl,
    configDir: undefined,
  });
  const msgs = observe[1].body.messages;
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      assert.equal(block.cache_control, undefined,
        `cache:false default must leave every content block free of cache_control, found: ${JSON.stringify(block)}`);
    }
  }
});
