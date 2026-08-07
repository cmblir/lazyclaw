// v5.3.2 — Orchestrator fallback is a true single-shot.
//
// Problem (pre-fix, providers/orchestrator.mjs:121-138):
//   When cfg.orchestrator was undefined (or had no workers), the
//   orchestrator printed a misleading "Defaulting to a single-agent
//   chain on claude-cli" banner and then STILL ran the full 3-phase
//   pipeline (Plan → Execute(N) → Synthesis) against the resolved
//   fallback backend. A trivial "what tools do I have" got expanded
//   into 4 subtasks.
//
// Contract (post-fix):
//   - cfg.orchestrator undefined  → exactly one sendMessage call to
//                                    the fallback provider, no plan.
//   - cfg.orchestrator.workers []  → same, no plan.
//   - cfg.orchestrator configured  → full 3-phase pipeline (covered
//                                    by phaseH-orchestrator-concurrency).
//
// We assert by installing a counting fake "claude-cli" provider, then
// sending a message through the orchestrator with no orchestrator
// config. Exactly ONE sendMessage call must reach the fake, and the
// output must NOT contain the multi-agent phase headers.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import { makeOrchestratorProvider } from '../providers/orchestrator.mjs';
import { PROVIDERS, PROVIDER_INFO } from '../providers/registry.mjs';

// Imports the orchestrator provider, which resolves its own config directory and
// persists a trajectory per run. Isolated so a future edit here cannot start
// writing fake test records into the developer's real ~/.pompos.
const _testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-test-cfg-'));
process.env.POMPOS_CONFIG_DIR = _testConfigDir;
after(() => fs.rmSync(_testConfigDir, { recursive: true, force: true }));


// orchestrator no longer imports the registry (cycle broken); callers inject
// the provider lookup, exactly as registry.registerOrchestrator does.
const _lookup = (p) => ({ prov: PROVIDERS[p], info: PROVIDER_INFO[p] });

function installCountingProvider(name, reply = 'hello from fake') {
  const calls = [];
  const original = PROVIDERS[name];
  const originalInfo = PROVIDER_INFO[name];
  PROVIDERS[name] = {
    async *sendMessage(messages, opts = {}) {
      calls.push({ messages, opts });
      yield String(reply);
    },
  };
  PROVIDER_INFO[name] = { defaultModel: 'fake-model' };
  return {
    calls,
    restore() {
      if (original) PROVIDERS[name] = original; else delete PROVIDERS[name];
      if (originalInfo) PROVIDER_INFO[name] = originalInfo; else delete PROVIDER_INFO[name];
    },
  };
}

async function drainStream(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(String(c));
  return chunks.join('');
}

test('v5.3.2 — undefined cfg.orchestrator produces a single passthrough call (no plan/execute/synthesis)', async () => {
  const fake = installCountingProvider('claude-cli', 'direct answer\n');
  try {
    const cfg = {}; // intentionally no orchestrator, no provider
    const prov = makeOrchestratorProvider({ cfgGetter: () => cfg, lookup: _lookup });
    const out = await drainStream(prov.sendMessage(
      [{ role: 'user', content: 'what tools do I have?' }],
    ));

    assert.equal(fake.calls.length, 1,
      `expected exactly 1 underlying sendMessage call (single-shot), got ${fake.calls.length}`);

    // Original user message must reach the fallback verbatim — not a
    // synthesised subtask string.
    const passed = fake.calls[0].messages;
    assert.ok(Array.isArray(passed) && passed.length >= 1, 'messages array passed through');
    const lastUser = [...passed].reverse().find(m => m.role === 'user');
    assert.ok(lastUser && lastUser.content.includes('what tools do I have'),
      `expected original user message to reach fallback verbatim; got: ${JSON.stringify(passed)}`);

    // Output must NOT contain the multi-agent phase markers.
    assert.ok(!out.includes('### 1. Planning'), `must NOT run Planning phase; got: ${out.slice(0, 300)}`);
    assert.ok(!/### 2\. Executing/.test(out), 'must NOT run Execute phase');
    assert.ok(!out.includes('### 3. Synthesis'), 'must NOT run Synthesis phase');
    assert.ok(!out.includes('🦞 Orchestrator'), 'must NOT emit orchestrator banner');

    // It MUST surface the fallback reply.
    assert.ok(out.includes('direct answer'), `expected fallback reply in output; got: ${out.slice(0, 300)}`);

    // And it should explain that orchestrator is not configured.
    assert.ok(/not configured|single-shot/i.test(out),
      `expected single-shot hint in output; got: ${out.slice(0, 300)}`);
  } finally {
    fake.restore();
  }
});

test('v5.3.2 — cfg.orchestrator with empty workers also short-circuits to single-shot', async () => {
  const fake = installCountingProvider('claude-cli', 'direct again\n');
  try {
    const cfg = {
      orchestrator: {
        // planner present, workers missing/empty → still no multi-agent flow
        planner: 'claude-cli:claude-opus-4-7',
        workers: [],
      },
    };
    const prov = makeOrchestratorProvider({ cfgGetter: () => cfg, lookup: _lookup });
    const out = await drainStream(prov.sendMessage(
      [{ role: 'user', content: 'hi' }],
    ));

    assert.equal(fake.calls.length, 1,
      `empty workers must still be single-shot; got ${fake.calls.length} calls`);
    assert.ok(!out.includes('### 1. Planning'), 'no planning phase');
    assert.ok(out.includes('direct again'), 'fallback reply surfaced');
  } finally {
    fake.restore();
  }
});

test('v5.3.2 — when cfg.provider points at a real backend, single-shot uses THAT provider', async () => {
  // User configured `cfg.provider = "openai"` via onboard but never
  // touched orchestrator. The single-shot fallback must honour their
  // chat-provider choice, not silently force claude-cli.
  const fakeOpenAI = installCountingProvider('openai', 'openai reply\n');
  const fakeClaude = installCountingProvider('claude-cli', 'claude reply\n');
  try {
    const cfg = { provider: 'openai', model: 'gpt-4o' };
    const prov = makeOrchestratorProvider({ cfgGetter: () => cfg, lookup: _lookup });
    const out = await drainStream(prov.sendMessage(
      [{ role: 'user', content: 'route me right' }],
    ));

    assert.equal(fakeOpenAI.calls.length, 1, 'openai must be called exactly once');
    assert.equal(fakeClaude.calls.length, 0, 'claude-cli must NOT be called when cfg.provider=openai');
    assert.ok(out.includes('openai reply'), 'openai reply surfaced');
    assert.equal(fakeOpenAI.calls[0].opts.model, 'gpt-4o', 'configured model passed through');
  } finally {
    fakeOpenAI.restore();
    fakeClaude.restore();
  }
});
