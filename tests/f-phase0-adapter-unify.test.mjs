// tests/f-phase0-adapter-unify.test.mjs
//
// Phase 0 — adapter-unify. Two defects proven here:
//
// DEFECT A: runAgentTurn used a hard 4-case switch (adapterFor) that threw
//   PROVIDER_UNSUPPORTED for any OpenAI-compat / custom provider, even though
//   the trainer path (resolveToolUseAdapter) already falls through to the
//   OpenAI-compat adapter for exactly those providers. So groq/nim/openrouter
//   worked for text completion but the agentic turn loop (orchestrator
//   agenticWorkers, teams) threw. The fix routes runAgentTurn through
//   resolveToolUseAdapter and it must also carry the toolSchemas mapper.
//
// DEFECT B: the resp.calls loop ran tools sequentially and recorded a
//   hardcoded durationMs:0 in the trajectory. The fix runs the calls within a
//   turn concurrently and records the REAL per-call durationMs (surfaced on
//   each toolCalls entry).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveToolUseAdapter } from '../mas/provider_adapters.mjs';
import { runAgentTurn } from '../mas/agent_turn.mjs';

const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `lc-${p}-`));

function startMockOpenAI() {
  return new Promise((resolve) => {
    const queue = [];
    const posts = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c.toString(); });
      req.on('end', () => {
        let parsed = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* leave empty */ }
        posts.push({ body: parsed });
        const next = queue.shift();
        if (!next) { res.writeHead(500); res.end('queue empty'); return; }
        res.writeHead(next.status || 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(next.json));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        queue, posts,
        close: () => new Promise((r) => {
          try { server.closeAllConnections(); } catch { /* node <18 */ }
          server.close(() => r());
        }),
      });
    });
  });
}

test('DEFECT A: an openai-compat provider resolves a tool-use adapter with a toolSchemas mapper instead of throwing', async () => {
  const adapter = await resolveToolUseAdapter('groq');
  assert.equal(typeof adapter.callOnce, 'function', 'compat provider must resolve a callOnce');
  assert.equal(typeof adapter.toolSchemas, 'function', 'the loop needs a toolSchemas mapper');
  // The OpenAI-compat mapper is toOpenAITools: given one schema it yields one
  // { type:'function', function:{ name } } entry.
  const mapped = adapter.toolSchemas([{ name: 'read', description: 'd', parameters: { type: 'object', properties: {} } }]);
  assert.equal(mapped[0].type, 'function');
  assert.equal(mapped[0].function.name, 'read');
});

test('DEFECT A: runAgentTurn drives a full turn for an openai-compat provider (no PROVIDER_UNSUPPORTED throw)', async () => {
  const mock = await startMockOpenAI();
  try {
    mock.queue.push({
      json: { choices: [{ message: { role: 'assistant', content: 'compat answer' }, finish_reason: 'stop' }] },
    });
    const groqAgent = { name: 'w', role: 'R', provider: 'groq', model: 'llama-3.3-70b', tools: ['read', 'grep'] };
    const r = await runAgentTurn({
      agent: groqAgent,
      userMessage: 'hi',
      apiKey: 'gsk-test',
      baseUrl: mock.baseUrl, // explicit baseUrl wins over the vendor's real URL — no network hit
    });
    assert.equal(r.stoppedBy, 'final');
    assert.equal(r.text, 'compat answer');
  } finally {
    await mock.close();
  }
});

test('DEFECT A preserved: claude-cli still normalizes to kind:final via runAgentTurn', async () => {
  const FAKE = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'fake-claude.mjs');
  // The claude-cli adapter reads its binary from POMPOS_CLAUDE_BIN when set;
  // runAgentTurn does not forward a per-agent bin, so point the env at the fake.
  const prev = process.env.POMPOS_CLAUDE_BIN;
  process.env.POMPOS_CLAUDE_BIN = FAKE;
  try {
    const cliAgent = { name: 'c', role: 'R', provider: 'claude-cli', model: 'sonnet', tools: [] };
    const r = await runAgentTurn({ agent: cliAgent, userMessage: 'hi' });
    assert.equal(r.stoppedBy, 'final');
  } finally {
    if (prev === undefined) delete process.env.POMPOS_CLAUDE_BIN;
    else process.env.POMPOS_CLAUDE_BIN = prev;
  }
});

test('DEFECT B: two tool calls in one turn record nonzero, independent durationMs', async () => {
  const ws = tmpDir('p0-dur-ws');
  const cfg = tmpDir('p0-dur-cfg');
  const mock = await startMockOpenAI();
  try {
    // One assistant turn with TWO tool calls (bash sleeps of different lengths),
    // then a final text turn. The two sleeps make each call's real wall-clock
    // duration measurable and distinguishable.
    mock.queue.push({
      json: {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_slow', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'sleep 0.3' }) } },
              { id: 'call_fast', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'sleep 0.05' }) } },
            ],
          },
          finish_reason: 'tool_calls',
        }],
      },
    });
    mock.queue.push({
      json: { choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] },
    });

    const agent = { name: 'w', role: 'R', provider: 'groq', model: 'llama-3.3-70b', tools: ['bash'] };
    const started = Date.now();
    const r = await runAgentTurn({
      agent,
      userMessage: 'run both',
      apiKey: 'gsk-test',
      baseUrl: mock.baseUrl,
      cwd: ws,
      configDir: cfg,
      approve: async () => ({ approved: true }),
    });
    const wall = Date.now() - started;

    assert.equal(r.toolCalls.length, 2, 'both tool calls ran');
    const slow = r.toolCalls.find((c) => c.id === 'call_slow');
    const fast = r.toolCalls.find((c) => c.id === 'call_fast');
    assert.ok(slow && fast, 'both calls correlate by id');

    // Real, per-call, nonzero durations (was hardcoded 0).
    assert.equal(typeof slow.durationMs, 'number');
    assert.equal(typeof fast.durationMs, 'number');
    assert.ok(slow.durationMs > 0, `slow durationMs must be nonzero, got ${slow.durationMs}`);
    assert.ok(fast.durationMs > 0, `fast durationMs must be nonzero, got ${fast.durationMs}`);

    // Independent (not a shared/copied value): the 0.3s sleep clearly outlasts
    // the 0.05s sleep.
    assert.ok(slow.durationMs > fast.durationMs, `independent durations: slow(${slow.durationMs}) > fast(${fast.durationMs})`);

    // Concurrency: run in parallel, the turn's tool phase is bounded by the
    // slowest call, not the sum of both. Assert against the measured durations
    // (which absorb machine/load overhead equally) rather than an absolute
    // wall-clock bound, so the proof holds under CPU contention: sequential
    // execution would take at least slow+fast, concurrent stays under it.
    assert.ok(
      wall < slow.durationMs + fast.durationMs,
      `sleeps ran concurrently: wall=${wall}ms < slow(${slow.durationMs})+fast(${fast.durationMs})`,
    );
  } finally {
    await mock.close();
  }
});
