// Anthropic streaming emits onUsage only on message_stop; if the stream ends
// without that terminal event after usage was captured, the token counts were
// dropped (0 cost → the daemon cap under-counts). And stop_reason 'max_tokens'
// (the hard output cut) was never surfaced. Both are finalized once now, with
// the message_start input/cache tokens preserved (message_delta only updates
// output).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicProvider } from '../providers/anthropic.mjs';

function sseFetch(frames) {
  const sse = frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
  return async () => ({
    ok: true, status: 200, headers: new Map(),
    body: (async function* () { yield new TextEncoder().encode(sse); })(),
  });
}

async function run(frames) {
  const usage = [];
  const trunc = [];
  let text = '';
  for await (const c of anthropicProvider.sendMessage([{ role: 'user', content: 'hi' }], {
    apiKey: 'sk-ant-x', model: 'claude-sonnet-4-5', fetch: sseFetch(frames),
    onUsage: (u) => usage.push(u), onTruncated: (r) => trunc.push(r),
  })) { text += c; }
  return { usage, trunc, text };
}

test('anthropic: usage flushed even WITHOUT message_stop; input/cache from message_start preserved', async () => {
  const { usage } = await run([
    { event: 'message_start', data: { message: { usage: { input_tokens: 50, cache_read_input_tokens: 10 } } } },
    { event: 'message_delta', data: { usage: { output_tokens: 20 } } },
    // no message_stop
  ]);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].inputTokens, 50, 'input preserved from message_start');
  assert.equal(usage[0].outputTokens, 20, 'output merged from message_delta');
  assert.equal(usage[0].cacheReadInputTokens, 10);
});

test('anthropic: usage fires exactly once WITH message_stop', async () => {
  const { usage } = await run([
    { event: 'message_start', data: { message: { usage: { input_tokens: 5 } } } },
    { event: 'message_delta', data: { usage: { output_tokens: 3 } } },
    { event: 'message_stop', data: {} },
  ]);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].inputTokens, 5);
  assert.equal(usage[0].outputTokens, 3);
});

test('anthropic: stop_reason "max_tokens" signals truncation', async () => {
  const { trunc } = await run([
    { event: 'message_start', data: { message: { usage: { input_tokens: 5 } } } },
    { event: 'message_delta', data: { delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 100 } } },
    { event: 'message_stop', data: {} },
  ]);
  assert.deepEqual(trunc, ['max_tokens']);
});

test('anthropic: stop_reason "end_turn" is a clean finish', async () => {
  const { trunc } = await run([
    { event: 'message_start', data: { message: { usage: { input_tokens: 5 } } } },
    { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } } },
    { event: 'message_stop', data: {} },
  ]);
  assert.equal(trunc.length, 0);
});
