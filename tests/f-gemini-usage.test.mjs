// Gemini streaming must report usageMetadata, honor maxTokens, and signal
// truncation. The provider used to extract only text from candidates[].parts
// and never read usageMetadata or finishReason — so every Gemini turn reported
// 0 tokens to the cost cap (under-count, cap never trips), ignored a configured
// output cap, and treated a MAX_TOKENS cut as a clean finish.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiProvider } from '../providers/gemini.mjs';

function sseFetch(frames, capture) {
  return async (url, init) => {
    if (capture) { capture.url = url; capture.body = JSON.parse(init.body); }
    const sse = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
    return {
      ok: true, status: 200, headers: new Map(),
      body: (async function* () { yield new TextEncoder().encode(sse); })(),
    };
  };
}

async function run(frames, opts = {}) {
  const seenUsage = [];
  const seenTrunc = [];
  let text = '';
  for await (const c of geminiProvider.sendMessage([{ role: 'user', content: 'hi' }], {
    apiKey: 'k', model: 'gemini-2.0-flash', fetch: sseFetch(frames, opts.capture),
    onUsage: (u) => seenUsage.push(u), onTruncated: (r) => seenTrunc.push(r),
    ...opts,
  })) { text += c; }
  return { seenUsage, seenTrunc, text };
}

test('gemini: surfaces usageMetadata via onUsage exactly once with the FINAL (not summed) counts', async () => {
  const { seenUsage } = await run([
    { candidates: [{ content: { parts: [{ text: 'h' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } },
    { candidates: [{ content: { parts: [{ text: 'i' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, cachedContentTokenCount: 3 } },
  ]);
  assert.equal(seenUsage.length, 1);
  assert.equal(seenUsage[0].inputTokens, 11, 'final cumulative count, not 5+11');
  assert.equal(seenUsage[0].outputTokens, 7);
  assert.equal(seenUsage[0].cacheReadInputTokens, 3);
  assert.equal(seenUsage[0].totalCostUsd, 0);
});

test('gemini: honors opts.maxTokens via generationConfig.maxOutputTokens', async () => {
  const cap = {};
  await run([{ candidates: [{ content: { parts: [{ text: 'x' }] } }] }], { capture: cap, maxTokens: 128 });
  assert.equal(cap.body.generationConfig.maxOutputTokens, 128);
});

test('gemini: leaves generationConfig unset when no maxTokens', async () => {
  const cap = {};
  await run([{ candidates: [{ content: { parts: [{ text: 'x' }] } }] }], { capture: cap });
  assert.ok(!cap.body.generationConfig, 'no generationConfig without a cap');
});

test('gemini: finishReason MAX_TOKENS signals truncation', async () => {
  const { seenTrunc } = await run([
    { candidates: [{ content: { parts: [{ text: 'cut' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 128 } },
  ]);
  assert.deepEqual(seenTrunc, ['MAX_TOKENS']);
});
