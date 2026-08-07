// Phase A: TrajectoryRecord persistence (spec §3.3, canonical C1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { put, get, listByTaskId, OUTCOME_ENUM } from '../mas/trajectory_store.mjs';

function tmpDir() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-traj-'));
  return p;
}

test('OUTCOME_ENUM is exactly the canonical 3 values (C1)', () => {
  assert.deepEqual([...OUTCOME_ENUM].sort(), ['abandoned', 'done', 'failed']);
});

test('put → get round-trip preserves all fields', async () => {
  const dir = tmpDir();
  const rec = {
    taskId: 'task_test_1',
    agentName: 'worker-0',
    workerProvider: 'claude-cli',
    workerModel: 'claude-opus-4-7',
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
    systemPrompt: 'You are helpful.',
    userMessages: ['hello'],
    turns: [{
      turnIdx: 0, role: 'assistant', content: 'hi',
      toolCalls: [], tokensUsed: { input: 10, output: 5 },
    }],
    finalAnswer: 'hi',
    outcome: 'done',
  };
  const stored = await put(rec, { configDir: dir });
  assert.ok(stored.id, 'put assigns ULID');
  const loaded = await get(stored.id, { configDir: dir });
  assert.equal(loaded.taskId, 'task_test_1');
  assert.equal(loaded.outcome, 'done');
  assert.equal(loaded.turns.length, 1);
  assert.equal(loaded.turns[0].content, 'hi');
});

test('put rejects unknown outcome (C1 enum guard)', async () => {
  const dir = tmpDir();
  await assert.rejects(
    put({ taskId: 't', outcome: 'success', turns: [] }, { configDir: dir }),
    /outcome must be one of/,
  );
});

test('put redacts secrets in turn content before persistence', async () => {
  const dir = tmpDir();
  const rec = {
    taskId: 't_redact', agentName: 'a', workerProvider: 'anthropic',
    workerModel: 'claude-opus-4-7', startedAt: 1, endedAt: 2,
    systemPrompt: '', userMessages: [],
    turns: [{
      turnIdx: 0, role: 'assistant',
      content: 'use sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF1234567890abcdefgh and you are set',
      toolCalls: [],
    }],
    finalAnswer: '', outcome: 'done',
  };
  const stored = await put(rec, { configDir: dir });
  const loaded = await get(stored.id, { configDir: dir });
  assert.ok(!loaded.turns[0].content.includes('sk-ant-api03-AAAABBBB'),
    'secret leaked into trajectory');
});

test('listByTaskId returns records in insertion order', async () => {
  const dir = tmpDir();
  const base = { agentName: 'a', workerProvider: 'anthropic',
    workerModel: 'm', startedAt: 1, endedAt: 2,
    systemPrompt: '', userMessages: [], turns: [], finalAnswer: '', outcome: 'done' };
  const a = await put({ ...base, taskId: 't_list' }, { configDir: dir });
  const b = await put({ ...base, taskId: 't_list' }, { configDir: dir });
  const list = await listByTaskId('t_list', { configDir: dir });
  assert.equal(list.length, 2);
  assert.deepEqual(list.map(r => r.id), [a.id, b.id]);
});
