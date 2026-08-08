// Group A — LEARNING (close the loop end-to-end).
//
// Regression suite for the four hot-path fixes that silently kill the
// canonical learning loop in v5:
//   C3   — runAgentTurn used to be opt-in (trajectoryRef parameter);
//          callers that omitted it lost the trajectory write entirely.
//   C6   — installSynthesized used to drop the v5 frontmatter fields
//          (trained_by / confidence / trajectory_ref) so the resulting
//          SKILL.md couldn't drive cross-CLI dampening.
//   M1   — _runPostTask hoists computeConfidence above synthesizeSkill
//          so the produced SKILL.md actually carries a confidence
//          number.
//   M3   — agents.mjs default skillWrite is now 'auto'; mention_router
//          and the learning hub treat a missing field as 'auto' so a
//          fresh-install agent contributes a SKILL.md on first done.
//   M4   — tasks.appendTurn mirrors to fts_sessions with session_id
//          namespaced `task:<id>` so the recall tool surfaces task
//          transcripts.
//   M5   — installSynthesized's index_db row used to compute
//          `trained_by` with a broken operator-precedence ternary;
//          now an agent-installed skill whose frontmatter is
//          `trained_by: human` is indexed correctly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runLearning } from '../mas/learning.mjs';
import * as trajectoryStore from '../mas/trajectory_store.mjs';
import * as skills from '../skills.mjs';
import { installSynthesized } from '../mas/skill_synth.mjs';
import { runAgentTurn } from '../mas/agent_turn.mjs';
import { registerTeam } from '../teams.mjs';
import { registerAgent, DEFAULT_TOOLS } from '../agents.mjs';
import { registerTask, appendTurn as appendTaskTurn } from '../tasks.mjs';
import { openIndex, recall, closeIndex } from '../mas/index_db.mjs';

function tmpCfg(prefix = 'lc-groupA-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Anthropic-shaped mock fetch that returns a stable synthesised skill.
function fakeAnthropic(text) {
  return async (_url, _init) => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text }] }),
  });
}

const STANDARD_SKILL = (
  'name: from-learning-loop\n' +
  'description: a stable synth output used by the Group A loop tests\n\n' +
  '## When to Use\n- whenever the loop test runs\n\n' +
  '## Procedure\n1. do nothing\n\n' +
  '## Pitfalls\n- none\n\n' +
  '## Verification\n- assertions pass\n'
);

// ─── M5 ─────────────────────────────────────────────────────────────
test('M5 — installSynthesized respects frontmatter trained_by even when createdBy is agent', () => {
  const cfg = tmpCfg('lc-m5-');
  openIndex(cfg);
  // Install a skill from a frontmatter-laden body. parseFrontmatter on
  // re-read should report trained_by:'human' — and the fts_skills index
  // row must agree, because the broken `||` precedence used to drop
  // the meta value entirely.
  installSynthesized({
    name: 'human-curated-skill',
    description: 'a human-curated skill installed via the agent path',
    body: '## When to Use\n- when sasquatch-marker-phrase appears\n',
    sourceTask: 't_m5',
    createdBy: 'agent',
    trainedBy: 'human',
  }, cfg);
  const doc = fs.readFileSync(path.join(cfg, 'skills', 'human-curated-skill.md'), 'utf8');
  const { meta } = skills.parseFrontmatter(doc);
  assert.equal(meta.trained_by, 'human',
    `frontmatter trained_by should be 'human', got '${meta.trained_by}'`);
  const hits = recall('sasquatch', { configDir: cfg, scope: ['skills'], k: 5 }).hits;
  // Find our row in the recall output; without the parens fix this
  // returned trained_by:'agent' for every agent-installed skill.
  const ours = hits.find((h) => h.metadata && h.metadata.skill_name === 'human-curated-skill');
  assert.ok(ours, `expected a recall hit for human-curated-skill, got: ${JSON.stringify(hits)}`);
  assert.equal(ours.metadata.trained_by, 'human',
    `fts_skills.trained_by should be 'human', got '${ours.metadata.trained_by}'`);
  closeIndex(cfg);
});

// ─── C3 ─────────────────────────────────────────────────────────────
test('C3 — runAgentTurn persists a trajectory even when caller omits trajectoryRef', async () => {
  const cfg = tmpCfg('lc-c3-');
  trajectoryStore._resetCache();
  delete process.env.POMPOS_NO_TRAJECTORY;
  // Mock adapter that returns final on the first call; we drive runAgentTurn
  // through the anthropic adapter against a stub fetch so we don't need
  // a real provider.
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      id: 'msg_1', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }),
  });
  await runAgentTurn({
    agent: { name: 'a-c3', provider: 'anthropic', model: 'claude-opus-4-7', role: 'r', tools: DEFAULT_TOOLS },
    userMessage: 'hello',
    apiKey: 'sk-test',
    configDir: cfg,
    fetchImpl,
    // INTENTIONALLY no trajectoryRef
  });
  // Trajectory store should now have at least one record on disk in
  // <cfg>/trajectories/<bucket>/. Without the C3 fix this dir would
  // not exist at all.
  const dir = path.join(cfg, 'trajectories');
  assert.ok(fs.existsSync(dir), `trajectories/ should exist at ${dir}`);
  const buckets = fs.readdirSync(dir);
  assert.ok(buckets.length >= 1, 'expected at least one date bucket');
  const files = fs.readdirSync(path.join(dir, buckets[0])).filter((f) => f.endsWith('.jsonl'));
  assert.ok(files.length >= 1, 'expected at least one trajectory file');
});

test('C3 — POMPOS_NO_TRAJECTORY=1 disables the default persist for tests', async () => {
  const cfg = tmpCfg('lc-c3-off-');
  trajectoryStore._resetCache();
  process.env.POMPOS_NO_TRAJECTORY = '1';
  try {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        id: 'msg_1', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }),
    });
    await runAgentTurn({
      agent: { name: 'a-c3-off', provider: 'anthropic', model: 'claude-opus-4-7', role: 'r', tools: DEFAULT_TOOLS },
      userMessage: 'hello',
      apiKey: 'sk-test',
      configDir: cfg,
      fetchImpl,
    });
    const dir = path.join(cfg, 'trajectories');
    assert.equal(fs.existsSync(dir), false,
      'POMPOS_NO_TRAJECTORY=1 must suppress trajectory writes');
  } finally {
    delete process.env.POMPOS_NO_TRAJECTORY;
  }
});

// ─── M1 + C6 ────────────────────────────────────────────────────────
test('M1 + C6 — runLearning("post-task") installs a SKILL.md with confidence and trained_by', async () => {
  const cfg = tmpCfg('lc-m1-');
  trajectoryStore._resetCache();
  const res = await runLearning('post-task', {
    configDir: cfg,
    cfg: {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      trainer: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    },
    agent: { name: 'a-m1', provider: 'anthropic', model: 'claude-opus-4-7', role: 'r' },
    task: { id: 't-m1', title: 'm1', turns: [{ agent: 'user', text: 'do the thing' }, { agent: 'a-m1', text: 'ok' }] },
    apiKey: 'sk-test',
    fetchImpl: fakeAnthropic(STANDARD_SKILL),
  });
  assert.equal(res.trigger, 'post-task');
  assert.ok(res.results.confidence !== undefined && res.results.confidence !== null,
    `expected a numeric confidence, got ${res.results.confidence}`);
  assert.ok(res.results.installed, 'expected the installed skill envelope');
  // The on-disk SKILL.md must carry the v5 frontmatter fields.
  const skillFile = res.results.installed.path;
  const doc = fs.readFileSync(skillFile, 'utf8');
  const { meta } = skills.parseFrontmatter(doc);
  assert.equal(meta.trained_by, 'anthropic',
    `trained_by should be the trainer provider, got '${meta.trained_by}'`);
  assert.equal(meta.trained_on_model, 'claude-haiku-4-5',
    `trained_on_model should be the trainer model, got '${meta.trained_on_model}'`);
  assert.ok(meta.trajectory_ref, `trajectory_ref should be stamped, got '${meta.trajectory_ref}'`);
  const conf = Number(meta.confidence);
  assert.ok(Number.isFinite(conf) && conf >= 0 && conf <= 1,
    `confidence should be a number in [0,1], got '${meta.confidence}'`);
});

// ─── trajectory worker/trainer provider stamping ────────────────────
test('post-task trajectory carries workerProvider + trainerProvider', async () => {
  const cfg = tmpCfg('lc-trj-');
  trajectoryStore._resetCache();
  await runLearning('post-task', {
    configDir: cfg,
    cfg: {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      trainer: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    },
    agent: { name: 'a-trj', provider: 'anthropic', model: 'claude-opus-4-7', role: 'r' },
    task: { id: 't-trj', title: 'trj', turns: [{ agent: 'user', text: 'hi' }] },
    apiKey: 'sk-test',
    fetchImpl: fakeAnthropic(STANDARD_SKILL),
  });
  const records = await trajectoryStore.listByTaskId('t-trj', { configDir: cfg });
  assert.ok(records.length >= 1, 'expected at least one trajectory record');
  const rec = records[0];
  assert.equal(rec.workerProvider, 'anthropic',
    `workerProvider should be the agent provider, got '${rec.workerProvider}'`);
  assert.equal(rec.trainerProvider, 'anthropic',
    `trainerProvider should be the trainer provider, got '${rec.trainerProvider}'`);
});

// ─── M3 ─────────────────────────────────────────────────────────────
test('M3 — fresh agent with no explicit skillWrite still runs synthesizeSkill via runLearning("post-task")', async () => {
  const cfg = tmpCfg('lc-m3-');
  trajectoryStore._resetCache();
  // Fresh-install agent — no skillWrite set, no memoryWrite set. The
  // canonical funnel should still install the skill because the
  // default is now 'auto' and the learning hub doesn't gate on the
  // field at all (it runs unconditionally — the mention router still
  // honours the per-agent knob for backwards compatibility).
  const res = await runLearning('post-task', {
    configDir: cfg,
    cfg: { provider: 'anthropic', model: 'claude-opus-4-7' },
    agent: { name: 'a-m3', provider: 'anthropic', model: 'claude-opus-4-7', role: 'r' },
    task: { id: 't-m3', title: 'm3', turns: [{ agent: 'user', text: 'hi' }] },
    apiKey: 'sk-test',
    fetchImpl: fakeAnthropic(STANDARD_SKILL),
  });
  assert.ok(res.results.skill, 'expected a synthesised skill envelope');
  assert.ok(res.results.installed, 'expected an installed skill path');
  // The installed file should exist.
  assert.ok(fs.existsSync(res.results.installed.path),
    `installed skill file should exist at ${res.results.installed.path}`);
});

// ─── M4 ─────────────────────────────────────────────────────────────
test('M4 — tasks.appendTurn populates fts_sessions with session_id="task:<id>"', async () => {
  const cfg = tmpCfg('lc-m4-');
  process.env.POMPOS_CONFIG_DIR = cfg;
  openIndex(cfg);
  // Build the minimal team/agent so registerTask succeeds.
  registerAgent({ name: 'planner', role: 'r' }, cfg);
  registerTeam({ name: 'team-m4', agents: ['planner'], lead: 'planner' }, cfg);
  const task = registerTask({ id: 't_20260605_aaaaaa', title: 'm4 fixture', team: 'team-m4' }, cfg);
  appendTaskTurn(task.id, { agent: 'user', text: 'investigate the slack-thread bug', ts: new Date().toISOString() }, cfg);
  // FTS write-through happens through a dynamic import in a
  // queueMicrotask. Drain the event loop so the index row lands before
  // we query.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const out = recall('slack-thread', { configDir: cfg, scope: ['sessions'], k: 5 });
  const taskHit = out.hits.find((h) => h.metadata && h.metadata.session_id === `task:${task.id}`);
  assert.ok(taskHit,
    `expected fts_sessions row with session_id "task:${task.id}", got hits: ${JSON.stringify(out.hits)}`);
  closeIndex(cfg);
  delete process.env.POMPOS_CONFIG_DIR;
});
