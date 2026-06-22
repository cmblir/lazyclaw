// OpenAI streaming must (1) signal max_tokens truncation and (2) not lose usage
// when the upstream closes without a [DONE] sentinel.
//
// finish_reason 'length' is OpenAI's hard output-cut signal; the streaming
// provider only acted on 'tool_calls', so an interactive user silently received
// a truncated answer. And onUsage fired only inside the [DONE] branch, so a
// gateway that drops [DONE] after the usage frame stranded the token counts
// (0 cost → the daemon cap under-counts). Both are now finalized exactly once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openaiProvider } from '../providers/openai.mjs';

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
  for await (const c of openaiProvider.sendMessage([{ role: 'user', content: 'hi' }], {
    apiKey: 'k', model: 'gpt-4.1', fetch: streamFetch(frames),
    onUsage: (u) => usage.push(u), onTruncated: (r) => trunc.push(r),
  })) { text += c; }
  return { usage, trunc, text };
}

const frame = (o) => `data: ${JSON.stringify(o)}\n\n`;
const DONE = 'data: [DONE]\n\n';

test('openai: finish_reason "length" fires onTruncated exactly once', async () => {
  const { trunc, text } = await run([
    frame({ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }),
    DONE,
  ]);
  assert.equal(text, 'partial');
  assert.deepEqual(trunc, ['length']);
});

test('openai: finish_reason "stop" does not fire onTruncated', async () => {
  const { trunc } = await run([
    frame({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }),
    DONE,
  ]);
  assert.equal(trunc.length, 0);
});

test('openai: usage is flushed even when the stream ends WITHOUT [DONE]', async () => {
  const { usage } = await run([
    frame({ choices: [{ delta: { content: 'hi' } }] }),
    frame({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }),
    // no [DONE]
  ]);
  assert.equal(usage.length, 1, 'captured usage flushed on loop exit');
  assert.equal(usage[0].inputTokens, 11);
  assert.equal(usage[0].outputTokens, 7);
});

test('openai: usage fires exactly once WITH [DONE] (no double-flush)', async () => {
  const { usage } = await run([
    frame({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }),
    DONE,
  ]);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].inputTokens, 5);
});
