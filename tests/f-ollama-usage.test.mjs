// Ollama streaming must report token usage and signal truncation.
//
// The final newline-delimited frame carries `done:true` with prompt_eval_count
// (input) / eval_count (output) and a `done_reason`. The provider used to
// `return` on `done` without ever calling onUsage, so every Ollama turn
// contributed 0 tokens to the daemon cost cap (under-count → cap never trips),
// and a num_predict/context cut (done_reason 'length') was indistinguishable
// from a clean finish. Cost is always 0 for a local model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ollamaProvider } from '../providers/ollama.mjs';

function ndjsonFetch(frames) {
  return async () => ({
    ok: true,
    status: 200,
    body: (async function* () {
      for (const f of frames) yield new TextEncoder().encode(JSON.stringify(f) + '\n');
    })(),
  });
}

async function run(frames, opts = {}) {
  const seenUsage = [];
  const seenTrunc = [];
  let text = '';
  for await (const c of ollamaProvider.sendMessage([{ role: 'user', content: 'hi' }], {
    model: 'm', fetch: ndjsonFetch(frames),
    onUsage: (u) => seenUsage.push(u),
    onTruncated: (r) => seenTrunc.push(r),
    ...opts,
  })) { text += c; }
  return { seenUsage, seenTrunc, text };
}

test('ollama: reports prompt_eval_count/eval_count via onUsage exactly once, cost 0', async () => {
  const { seenUsage, text } = await run([
    { message: { content: 'hello' } },
    { done: true, prompt_eval_count: 17, eval_count: 42 },
  ]);
  assert.equal(text, 'hello');
  assert.equal(seenUsage.length, 1);
  assert.equal(seenUsage[0].inputTokens, 17);
  assert.equal(seenUsage[0].outputTokens, 42);
  assert.equal(seenUsage[0].totalCostUsd, 0, 'local model is always $0');
});

test('ollama: a done frame with no counts does not call onUsage', async () => {
  const { seenUsage } = await run([{ message: { content: 'hi' } }, { done: true }]);
  assert.equal(seenUsage.length, 0);
});

test('ollama: done_reason "length" signals truncation via onTruncated', async () => {
  const { seenTrunc } = await run([
    { message: { content: 'cut' } },
    { done: true, done_reason: 'length', prompt_eval_count: 5, eval_count: 256 },
  ]);
  assert.deepEqual(seenTrunc, ['length']);
});

test('ollama: done_reason "stop" is a clean finish (no truncation signal)', async () => {
  const { seenTrunc } = await run([
    { message: { content: 'done' } },
    { done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 9 },
  ]);
  assert.equal(seenTrunc.length, 0);
});
