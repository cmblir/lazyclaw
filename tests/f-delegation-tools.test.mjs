// FIX A4-delegation-tools — pins two broken agent tools:
//   BUG 1 task_spawn: forwarded {agent:'<name string>'} to runAgentTurn,
//     which reads agent.provider → a string has none → adapterFor throws
//     PROVIDER_UNSUPPORTED on EVERY call. Fix resolves the name → record
//     via agents.getAgent and hands runAgentTurn the record it expects.
//   BUG 2 delegate: dispatched to orchestrator.dispatchWorker, which was
//     never defined → 'orchestrator.dispatchWorker unavailable' on every
//     call. Fix implements a minimal one-shot worker dispatch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as del from '../mas/tools/delegation.mjs';
import * as orch from '../providers/orchestrator.mjs';
import { registerAgent } from '../agents.mjs';

function tmpConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaw-deleg-'));
}

// ── BUG 2: dispatchWorker must exist and be a function ──────────────────
// Pre-fix this export does not exist, so dispatchDelegate's lazy import
// finds `typeof orch.dispatchWorker !== 'function'` and the delegate tool
// returns the 'unavailable' error on every call.
test('orchestrator.dispatchWorker is exported (BUG 2 regression)', () => {
  assert.equal(typeof orch.dispatchWorker, 'function');
});

test('delegate returns {ok:true,text} for a real worker provider', async () => {
  // `mock` is a registered provider whose sendMessage echoes the prompt.
  del.__setDispatcher(null); // ensure the real dispatchDelegate path runs
  const t = del.TOOLS.find((x) => x.name === 'delegate');
  const r = await t.exec({ worker: 'mock', prompt: 'hello-worker' });
  assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
  assert.match(r.text, /hello-worker/);
});

test('delegate surfaces unknown worker provider as a clean error', async () => {
  del.__setDispatcher(null);
  const t = del.TOOLS.find((x) => x.name === 'delegate');
  const r = await t.exec({ worker: 'no-such-provider', prompt: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown worker/);
});

// ── BUG 1: task_spawn must resolve the agent NAME to a record ───────────
test('task_spawn resolves agent name to a record before runAgentTurn', async () => {
  const configDir = tmpConfigDir();
  registerAgent({ name: 'researcher', provider: 'anthropic', model: 'claude-x' }, configDir);

  let received = null;
  // __setTurnRunner is the seam the fix adds. Pre-fix it does not exist,
  // so this stub never intercepts and the real runAgentTurn throws
  // PROVIDER_UNSUPPORTED on the string agent — pinning BUG 1.
  del.__setTurnRunner(async (job) => {
    received = job;
    return { text: 'spawned-answer', stoppedBy: 'final', iterations: 1 };
  });

  const t = del.TOOLS.find((x) => x.name === 'task_spawn');
  const r = await t.exec({ agent: 'researcher', prompt: 'do research' }, { configDir });
  del.__setTurnRunner(null);

  assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
  assert.equal(r.text, 'spawned-answer');
  // The runner must receive a RECORD (object with .provider), not the
  // name string — this is the exact pre-fix bug.
  assert.ok(received, 'runAgentTurn stub was never called');
  assert.equal(typeof received.agent, 'object');
  assert.equal(received.agent.provider, 'anthropic');
  assert.equal(received.agent.name, 'researcher');
  assert.equal(received.userMessage, 'do research');
  assert.equal(received.configDir, configDir);

  fs.rmSync(configDir, { recursive: true, force: true });
});

test('task_spawn propagates the outer sandbox spec to the nested runner (default-on isolation)', async () => {
  const configDir = tmpConfigDir();
  registerAgent({ name: 'r2', provider: 'anthropic', model: 'x' }, configDir);
  let received = null;
  del.__setTurnRunner(async (job) => { received = job; return { text: 'ok', stoppedBy: 'final', iterations: 1 }; });
  const t = del.TOOLS.find((x) => x.name === 'task_spawn');
  const spec = { kind: 'local', confiner: 'auto' };
  await t.exec({ agent: 'r2', prompt: 'go' }, { configDir, sandbox: spec });
  del.__setTurnRunner(null);
  // A spawned sub-agent must inherit the parent turn's confinement, not run free.
  assert.equal(received.sandbox, spec, 'nested runner must receive the outer sandbox spec');
  fs.rmSync(configDir, { recursive: true, force: true });
});

test('task_spawn on an unknown agent returns a clean error (no throw)', async () => {
  const configDir = tmpConfigDir();
  let called = false;
  del.__setTurnRunner(async () => { called = true; return { text: '' }; });

  const t = del.TOOLS.find((x) => x.name === 'task_spawn');
  const r = await t.exec({ agent: 'ghost', prompt: 'hi' }, { configDir });
  del.__setTurnRunner(null);

  assert.equal(r.ok, false);
  assert.equal(r.error, 'task_spawn: unknown agent ghost');
  assert.equal(called, false, 'runner must not run for an unknown agent');

  fs.rmSync(configDir, { recursive: true, force: true });
});
