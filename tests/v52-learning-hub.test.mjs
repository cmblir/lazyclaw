// v5.2 — mas/learning.mjs runLearning dispatch + trainer fallback (canonical decision C2).
//
// Validates the canonical post-hoc learning funnel:
//   - post-task runs trajectory_store.put + synthesizeSkill + updateUserModel
//   - post-failure tags synthesizeSkill with outcome:'failed' (anti-pattern)
//   - active-recall-miss decrements skill confidence and archives below the threshold
//   - unknown triggers return an envelope, do not throw
//   - resolveTrainer routes via cfg.trainer when supplied
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLearning, TRIGGERS } from '../mas/learning.mjs';
import * as trajectoryStore from '../mas/trajectory_store.mjs';
import * as skills from '../skills.mjs';
import { assembleSkillDoc } from '../mas/skill_synth.mjs';

function tmpCfg() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-learning-'));
}

// A fakeFetch that returns a stable Anthropic-shaped reply with a
// synthesised skill body. Tags the call so the test can assert which
// trainer model the call actually used.
function makeFakeFetch(observe) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    observe.push({ url, model: body.model, system: body.system || '', user: body.messages?.[0]?.content || '' });
    return {
      ok: true,
      json: async () => ({
        content: [{
          type: 'text',
          text:
            'name: from-learning-hub\n' +
            'description: a synthesised skill used in the learning-hub test\n\n' +
            '## When to Use\n- when the test runs\n\n' +
            '## Procedure\n1. nothing special\n\n' +
            '## Pitfalls\n- none\n\n' +
            '## Verification\n- assertions pass\n',
        }],
      }),
    };
  };
}

test('TRIGGERS frozen list matches the five canonical triggers', () => {
  assert.deepEqual([...TRIGGERS], [
    'post-task', 'post-failure', 'nudge', 'active-recall-miss', 'periodic-curation',
  ]);
});

test('runLearning("post-task") writes a trajectory with outcome:done + task.id', async () => {
  const cfgDir = tmpCfg();
  trajectoryStore._resetCache();
  const calls = [];
  const res = await runLearning('post-task', {
    configDir: cfgDir,
    cfg: { provider: 'anthropic', model: 'claude-opus-4-7' },
    agent: { name: 'a1', provider: 'anthropic', model: 'claude-opus-4-7', role: 'r' },
    task: { id: 'task-A', title: 't', turns: [{ agent: 'user', text: 'hi' }, { agent: 'a1', text: 'ok' }] },
    apiKey: 'k',
    fetchImpl: makeFakeFetch(calls),
  });
  assert.equal(res.trigger, 'post-task');
  const records = await trajectoryStore.listByTaskId('task-A', { configDir: cfgDir });
  assert.ok(records.length >= 1, 'expected at least one trajectory record for task-A');
  assert.equal(records[0].outcome, 'done');
});

test('runLearning("post-task") routes synth + user-model via resolveTrainer(cfg)', async () => {
  const cfgDir = tmpCfg();
  trajectoryStore._resetCache();
  const calls = [];
  const res = await runLearning('post-task', {
    configDir: cfgDir,
    cfg: {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      trainer: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    },
    agent: { name: 'a2', provider: 'anthropic', model: 'claude-opus-4-7', role: 'r' },
    task: { id: 'task-B', title: 't', turns: [{ agent: 'user', text: 'hello' }] },
    sessionTurns: [{ role: 'user', content: 'hello' }],
    apiKey: 'k',
    fetchImpl: makeFakeFetch(calls),
  });
  assert.equal(res.trigger, 'post-task');
  // Both the synth call AND the user-model call should hit the trainer's
  // claude-haiku model, NOT the chat opus model.
  const models = calls.map(c => c.model);
  assert.ok(models.every(m => m === 'claude-haiku-4-5'),
    `expected every call to use claude-haiku-4-5, got ${JSON.stringify(models)}`);
  assert.ok(models.length >= 2, `expected synth + user-model calls, got ${models.length}`);
});

test('runLearning("post-failure") tags synthesizeSkill with outcome:"failed" (anti-pattern)', async () => {
  const cfgDir = tmpCfg();
  trajectoryStore._resetCache();
  let observedUserMessage = '';
  const fakeFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    observedUserMessage = body.messages?.[0]?.content || '';
    return {
      ok: true,
      json: async () => ({
        content: [{
          type: 'text',
          text:
            'name: avoid-the-thing\n' +
            'description: anti-pattern from failed-task test\n\n' +
            '## What Failed\n- the test\n\n' +
            '## Why\n- so we test it\n\n' +
            '## Avoid\n- do not\n',
        }],
      }),
    };
  };
  const res = await runLearning('post-failure', {
    configDir: cfgDir,
    cfg: { provider: 'anthropic', model: 'claude-opus-4-7' },
    agent: { name: 'a3', provider: 'anthropic', model: 'claude-opus-4-7', role: 'r' },
    task: { id: 'task-C', title: 'fail', turns: [{ agent: 'user', text: 'broken' }] },
    apiKey: 'k',
    fetchImpl: fakeFetch,
  });
  assert.equal(res.trigger, 'post-failure');
  // post-failure must use the anti-pattern prompt, which mentions "FAILED".
  assert.ok(observedUserMessage.includes('FAILED'),
    `expected anti-pattern prompt to mention FAILED, got: ${observedUserMessage.slice(0, 200)}`);
  // The trajectory record must carry outcome:'failed'.
  const records = await trajectoryStore.listByTaskId('task-C', { configDir: cfgDir });
  assert.ok(records.length >= 1);
  assert.equal(records[0].outcome, 'failed');
});

test('runLearning("unknown-trigger") returns { error: "UNKNOWN_TRIGGER" } without throwing', async () => {
  const res = await runLearning('not-a-real-trigger', {});
  assert.equal(res.error, 'UNKNOWN_TRIGGER');
  assert.deepEqual(res.known, [...TRIGGERS]);
});

test('runLearning swallows individual sub-routine failures — one broken hook never blocks the others', async () => {
  const cfgDir = tmpCfg();
  trajectoryStore._resetCache();
  // synthesizeSkill will throw (no fetchImpl + bogus provider) but
  // trajectory_store.put MUST still succeed because each step is in
  // its own try/catch.
  const res = await runLearning('post-task', {
    configDir: cfgDir,
    cfg: { provider: 'anthropic', model: 'claude-opus-4-7' },
    agent: { name: 'a4', provider: 'this-provider-does-not-exist', model: 'm', role: 'r' },
    task: { id: 'task-D', title: 't', turns: [{ agent: 'user', text: 'hi' }] },
  });
  assert.equal(res.trigger, 'post-task');
  // Trajectory put should have succeeded even though skill+user-model failed.
  const records = await trajectoryStore.listByTaskId('task-D', { configDir: cfgDir });
  assert.ok(records.length >= 1, 'trajectory write must not be blocked by a downstream failure');
});

test('runLearning("active-recall-miss") decrements confidence on a known skill', async () => {
  const cfgDir = tmpCfg();
  // Seed a skill with confidence 0.8 so a -0.1 decrement leaves it
  // above the archive threshold (0.3).
  const doc = assembleSkillDoc({
    name: 'fading-skill',
    description: 'a skill we will fade',
    body: '## When to Use\n- some condition\n',
    confidence: 0.8,
  });
  skills.installSkill('fading-skill', doc, cfgDir);

  const res = await runLearning('active-recall-miss', {
    configDir: cfgDir,
    cfg: {},
    skill: { name: 'fading-skill' },
  });
  assert.equal(res.trigger, 'active-recall-miss');
  assert.equal(res.results.action, 'decremented');
  const after = skills.loadSkill('fading-skill', cfgDir);
  const { meta } = skills.parseFrontmatter(after);
  assert.ok(Math.abs(Number(meta.confidence) - 0.7) < 1e-9,
    `expected confidence ~0.7 after decrement, got ${meta.confidence}`);
});

test('runLearning("active-recall-miss") archives a skill that falls below the threshold', async () => {
  const cfgDir = tmpCfg();
  const doc = assembleSkillDoc({
    name: 'about-to-die',
    description: 'will fall under 0.3',
    body: '## When to Use\n- never\n',
    confidence: 0.35,
  });
  skills.installSkill('about-to-die', doc, cfgDir);

  const res = await runLearning('active-recall-miss', {
    configDir: cfgDir,
    cfg: {},
    skill: { name: 'about-to-die' },
  });
  assert.equal(res.results.action, 'archived');
  assert.equal(skills.skillExists('about-to-die', cfgDir), false);
});

test('runLearning("periodic-curation") runs the real curator (no longer a stub)', async () => {
  // periodic-curation used to be a {stub:true} no-op; it now replays the real
  // skills_curator against configDir. curateImpl/now are injection seams so
  // the pass is deterministic in the test.
  let called = null;
  const res = await runLearning('periodic-curation', {
    cfg: {},
    configDir: '/tmp/lc-curate-test',
    now: 1_700_000_000_000,
    curateImpl: (dir, now) => { called = { dir, now }; return { archived: [], scanned: 0 }; },
  });
  assert.equal(res.trigger, 'periodic-curation');
  assert.equal(res.results.stub, undefined);            // no longer a stub
  assert.deepEqual(res.results, { archived: [], scanned: 0 });
  assert.deepEqual(res.errors, []);
  assert.deepEqual(called, { dir: '/tmp/lc-curate-test', now: 1_700_000_000_000 });
});
