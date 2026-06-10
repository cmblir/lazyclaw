// tests/f-learn-queue.test.mjs — the /inbound learning hook runs through a
// serialised, depth-capped queue so a channel-message burst cannot fan out
// unbounded trainer LLM calls / claude-cli subprocesses.

import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueLearning, _learnQueueStats, _resetLearnQueue } from '../daemon/lib/learn_queue.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('jobs run one at a time, in order', async () => {
  _resetLearnQueue();
  const order = [];
  let concurrent = 0, maxConcurrent = 0;
  const mk = (id) => async () => {
    concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
    await sleep(20);
    order.push(id);
    concurrent--;
  };
  for (let i = 0; i < 4; i++) enqueueLearning(mk(i));
  await sleep(200);
  assert.deepEqual(order, [0, 1, 2, 3]);
  assert.equal(maxConcurrent, 1, 'strictly serialised');
});

test('a rejecting job does not stall the queue', async () => {
  _resetLearnQueue();
  const ran = [];
  enqueueLearning(async () => { throw new Error('trainer down'); });
  enqueueLearning(async () => { ran.push('after'); });
  await sleep(50);
  assert.deepEqual(ran, ['after']);
});

test('queue depth is capped: overflow jobs are dropped, accepted ones still run', async () => {
  _resetLearnQueue();
  let ran = 0;
  const accepted = [];
  // First job blocks the runner so the rest stack in the waiting line.
  enqueueLearning(async () => { await sleep(80); ran++; });
  for (let i = 0; i < 20; i++) accepted.push(enqueueLearning(async () => { ran++; }));
  assert.ok(accepted.includes(false), 'some overflow jobs were dropped');
  assert.ok(_learnQueueStats().dropped > 0);
  await sleep(300);
  const stats = _learnQueueStats();
  assert.equal(stats.waiting, 0, 'queue drained');
  assert.ok(ran >= 9, `accepted jobs all ran (ran=${ran})`);
  _resetLearnQueue();
});
