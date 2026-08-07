// tests/f-learning-parallel-trainers.test.mjs
//
// The post-task learning hook makes two independent trainer/LLM calls —
// synthesizeSkill and updateUserModel — which used to run sequentially (await
// one whole round-trip, then start the other). They now run concurrently via
// Promise.allSettled. This pins the preserved contract: BOTH branches still
// fire and the skill is still produced (a regression that dropped a branch
// would change the fetch count or lose results.skill).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLearning } from '../mas/learning.mjs';

const tmpCfg = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-lpar-'));

const STANDARD_SKILL = (
  'name: parallel-trainer-skill\n' +
  'description: stable synth output for the parallel-trainers test\n\n' +
  '## When to Use\n- whenever the test runs\n\n' +
  '## Procedure\n1. do nothing\n'
);

test('post-task fires both the skill-synth and user-model trainer calls', async () => {
  const cfg = tmpCfg();
  let fetchCalls = 0;
  const countingFetch = async () => {
    fetchCalls++;
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: STANDARD_SKILL }] }) };
  };
  const res = await runLearning('post-task', {
    configDir: cfg,
    cfg: { provider: 'anthropic', model: 'claude-opus-4-7' },
    agent: { name: 'a-par', provider: 'anthropic', model: 'claude-opus-4-7', role: 'r' },
    task: { id: 't-par', title: 'par', turns: [{ agent: 'user', text: 'hello world from the user' }] },
    apiKey: 'sk-test',
    fetchImpl: countingFetch,
  });
  assert.ok(res.results.skill, 'skill-synth branch must still produce a skill');
  assert.ok(fetchCalls >= 2, `both trainer calls must fire (got ${fetchCalls} fetch calls)`);
});
