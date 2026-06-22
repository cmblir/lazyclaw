// openai_compat (groq/together/etc) shares the OpenAI streaming shape and so
// shared the same two defects: finish_reason 'length' ignored (silent
// truncation) and onUsage only fired inside the [DONE] branch (usage stranded
// if the gateway drops [DONE]). Both finalized exactly once now.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOpenAICompatProvider } from '../providers/openai_compat.mjs';

const prov = makeOpenAICompatProvider({ name: 'groq', baseUrl: 'https://api.groq.com/openai/v1' });

function streamFetch(frames) {
  return async () => ({
    ok: true, status: 200, headers: new Map(),
    body: (async function* () { for (const f of frames) yield new TextEncoder().encode(f); })(),
  });
}

async function run(frames) {
  const usage = [];
  const trunc = [];
  let text = '';
  for await (const c of prov.sendMessage([{ role: 'user', content: 'hi' }], {
    apiKey: 'k', model: 'llama-3.1-8b', fetch: streamFetch(frames),
    onUsage: (u) => usage.push(u), onTruncated: (r) => trunc.push(r),
  })) { text += c; }
  return { usage, trunc, text };
}

const frame = (o) => `data: ${JSON.stringify(o)}\n\n`;
const DONE = 'data: [DONE]\n\n';

test('openai_compat: finish_reason "length" fires onTruncated once', async () => {
  const { trunc } = await run([
    frame({ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }),
    DONE,
  ]);
  assert.deepEqual(trunc, ['length']);
});

test('openai_compat: usage flushed even when the stream ends WITHOUT [DONE]', async () => {
  const { usage } = await run([
    frame({ choices: [{ delta: { content: 'hi' } }] }),
    frame({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } }),
  ]);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].inputTokens, 9);
  assert.equal(usage[0].outputTokens, 4);
});

test('openai_compat: usage fires exactly once WITH [DONE]', async () => {
  const { usage } = await run([
    frame({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
    DONE,
  ]);
  assert.equal(usage.length, 1);
});
