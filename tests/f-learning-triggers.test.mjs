// g2-learning-triggers — wire two dead learning-loop triggers.
//
// Pins two gaps the audit flagged in mas/learning.mjs:
//   (a) periodic-curation was an explicit {stub:true} no-op; it must now
//       run the real skills_curator.curate(configDir, now) and return its
//       result (clock injectable for determinism).
//   (b) post-failure had zero production callers; finalizeTerminalStop
//       (router terminal-stop path) must fire runLearning('post-failure')
//       on budget/idle/failed stops, and NOT on abort.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runLearning } from '../mas/learning.mjs';
import { finalizeTerminalStop } from '../mas/router_termination.mjs';
import * as skills from '../skills.mjs';
import * as curator from '../skills_curator.mjs';
import { assembleSkillDoc } from '../mas/skill_synth.mjs';

function tmpCfg() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-learn-triggers-'));
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ── (a) periodic-curation now invokes curate and returns its real result ──

test('runLearning("periodic-curation") runs the real curator (no longer {stub:true})', async () => {
  const cfgDir = tmpCfg();
  // An agent-authored skill that has been idle long enough to archive.
  const doc = assembleSkillDoc({
    name: 'aged-agent-skill',
    description: 'an agent-authored skill that should be archived by curation',
    body: '## When to Use\n- never, it is old\n',
    createdBy: 'agent',
    sourceTask: 't-old',
  });
  skills.installSkill('aged-agent-skill', doc, cfgDir);
  // Stamp a stale lastUsedAt (>90d before our injected now).
  const usedAt = 1_000_000_000_000;
  curator.recordUsage('aged-agent-skill', cfgDir, usedAt);
  const now = usedAt + 100 * DAY_MS;

  const res = await runLearning('periodic-curation', { configDir: cfgDir, now });

  assert.equal(res.trigger, 'periodic-curation');
  // Pre-fix this was {stub:true}; now it must be the curator's real shape.
  assert.notEqual(res.results?.stub, true);
  assert.ok(Array.isArray(res.results?.archived), 'result carries the curator archived[] list');
  assert.deepEqual(res.results.archived, ['aged-agent-skill']);
  // Side effect of a real curation pass: the skill is physically archived.
  assert.equal(skills.skillExists('aged-agent-skill', cfgDir), false);
});

test('runLearning("periodic-curation") defaults the clock to Date.now() when no now injected', async () => {
  const cfgDir = tmpCfg(); // empty store → curate sweeps nothing, no throw
  const res = await runLearning('periodic-curation', { configDir: cfgDir });
  assert.equal(res.trigger, 'periodic-curation');
  assert.notEqual(res.results?.stub, true);
  assert.ok(Array.isArray(res.results?.archived));
});

// ── (b) finalizeTerminalStop fires post-failure learning ──────────────────

function harness() {
  const calls = [];
  const tasksMod = { patchTask: (id, patch) => ({ id, ...patch }) };
  const postToThread = async () => {};
  const learnCalls = [];
  const runLearningImpl = (trigger, ctx) => {
    learnCalls.push({ trigger, ctx });
    return Promise.resolve();
  };
  return { calls, tasksMod, postToThread, learnCalls, runLearningImpl };
}

async function flushMicrotasks() {
  // Let any queued fire-and-forget learning microtask run.
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

for (const stoppedBy of ['budget', 'failed', 'idle']) {
  test(`finalizeTerminalStop fires post-failure learning on a ${stoppedBy} stop`, async () => {
    const h = harness();
    const task = { id: 'task-1' };
    await finalizeTerminalStop({
      stoppedBy,
      iterations: 3,
      current: task,
      configDir: '/tmp/x',
      cfg: { provider: 'anthropic' },
      task,
      tasksMod: h.tasksMod,
      postToThread: h.postToThread,
      slackSender: null,
      runLearningImpl: h.runLearningImpl,
    });
    await flushMicrotasks();
    assert.equal(h.learnCalls.length, 1, 'exactly one learning call fired');
    assert.equal(h.learnCalls[0].trigger, 'post-failure');
    assert.equal(h.learnCalls[0].ctx.task, task);
    assert.equal(h.learnCalls[0].ctx.configDir, '/tmp/x');
  });
}

test('finalizeTerminalStop does NOT fire learning on an abort stop', async () => {
  const h = harness();
  const task = { id: 'task-2' };
  await finalizeTerminalStop({
    stoppedBy: 'abort',
    iterations: 3,
    current: task,
    configDir: '/tmp/x',
    cfg: {},
    task,
    tasksMod: h.tasksMod,
    postToThread: h.postToThread,
    slackSender: null,
    runLearningImpl: h.runLearningImpl,
  });
  await flushMicrotasks();
  assert.equal(h.learnCalls.length, 0, 'abort must not teach an anti-pattern');
});

test('finalizeTerminalStop does NOT fire learning on a done stop (no-op exit)', async () => {
  const h = harness();
  const task = { id: 'task-3', status: 'done' };
  const out = await finalizeTerminalStop({
    stoppedBy: 'done',
    iterations: 1,
    current: task,
    configDir: '/tmp/x',
    cfg: {},
    task,
    tasksMod: h.tasksMod,
    postToThread: h.postToThread,
    slackSender: null,
    runLearningImpl: h.runLearningImpl,
  });
  await flushMicrotasks();
  assert.equal(out, task);
  assert.equal(h.learnCalls.length, 0);
});

test('finalizeTerminalStop degrades to no-op learning when task/cfg absent', async () => {
  const h = harness();
  const current = { id: 'task-4' };
  // No `task` and no `runLearningImpl` passed: must not throw, must not fire.
  await assert.doesNotReject(finalizeTerminalStop({
    stoppedBy: 'budget',
    iterations: 2,
    current,
    configDir: '/tmp/x',
    tasksMod: h.tasksMod,
    postToThread: h.postToThread,
    slackSender: null,
  }));
});
