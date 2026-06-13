// tests/f-provider-output-tokens.test.mjs — two output-token fixes.
//
// FIX 1: the native OpenAI provider must emit `max_completion_tokens`
//   (not `max_tokens`) for o-series reasoning models, which return HTTP
//   400 'Unsupported parameter: max_tokens, use max_completion_tokens'.
//   Covers both the streaming provider (providers/openai.mjs) and the
//   tool-use adapter (providers/tool_use/openai.mjs). openai_compat is
//   explicitly NOT touched — groq/together/etc still accept max_tokens.
//
// FIX 2: tui/run_turn.mjs must thread a configurable max-output-tokens
//   (cfg.maxTokens) through to the provider as opts.maxTokens when it is
//   a positive finite number, and leave it unset otherwise so the
//   per-provider DEFAULT_MAX_TOKENS (4096) still applies.
//
// Both fixes are exercised with stub fetch / stub provider — no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openaiProvider } from '../providers/openai.mjs';
import { callOnce } from '../providers/tool_use/openai.mjs';
import { makeOpenAICompatProvider } from '../providers/openai_compat.mjs';
import { makeRunTurn } from '../tui/run_turn.mjs';

// A stub fetch that captures the request body and returns a minimal SSE
// stream that the streaming providers can drain (`data: [DONE]\n\n`).
function makeStreamFetch(capture) {
  return async function stubFetch(url, init) {
    capture.url = url;
    capture.body = JSON.parse(init.body);
    const sse = 'data: [DONE]\n\n';
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      body: (async function* () { yield new TextEncoder().encode(sse); })(),
    };
  };
}

// A stub fetch for the non-streaming tool-use adapter: captures the body
// and returns a JSON `final` response.
function makeJsonFetch(capture) {
  return async function stubFetch(url, init) {
    capture.url = url;
    capture.body = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    };
  };
}

async function drain(iter) {
  for await (const _ of iter) { /* consume */ }
}

// ── FIX 1: native openai streaming provider ──────────────────────────────
test('openai streaming: reasoning model emits max_completion_tokens, not max_tokens', async () => {
  const cap = {};
  await drain(openaiProvider.sendMessage(
    [{ role: 'user', content: 'hi' }],
    { apiKey: 'k', model: 'o3-pro', fetch: makeStreamFetch(cap), maxTokens: 200 },
  ));
  assert.equal(cap.body.max_completion_tokens, 200, 'reasoning model must use max_completion_tokens');
  assert.ok(!('max_tokens' in cap.body), 'reasoning model must NOT send max_tokens');
});

test('openai streaming: normal model emits max_tokens, not max_completion_tokens', async () => {
  const cap = {};
  await drain(openaiProvider.sendMessage(
    [{ role: 'user', content: 'hi' }],
    { apiKey: 'k', model: 'gpt-4.1', fetch: makeStreamFetch(cap), maxTokens: 200 },
  ));
  assert.equal(cap.body.max_tokens, 200, 'normal model must use max_tokens');
  assert.ok(!('max_completion_tokens' in cap.body), 'normal model must NOT send max_completion_tokens');
});

// ── FIX 1: native openai tool-use adapter ─────────────────────────────────
test('openai tool-use: reasoning model emits max_completion_tokens, not max_tokens', async () => {
  const cap = {};
  await callOnce({
    messages: [{ role: 'user', content: 'hi' }],
    apiKey: 'k',
    model: 'o4-mini',
    maxTokens: 321,
    fetchImpl: makeJsonFetch(cap),
  });
  assert.equal(cap.body.max_completion_tokens, 321, 'reasoning model must use max_completion_tokens');
  assert.ok(!('max_tokens' in cap.body), 'reasoning model must NOT send max_tokens');
});

test('openai tool-use: normal model emits max_tokens, not max_completion_tokens', async () => {
  const cap = {};
  await callOnce({
    messages: [{ role: 'user', content: 'hi' }],
    apiKey: 'k',
    model: 'gpt-4.1',
    maxTokens: 321,
    fetchImpl: makeJsonFetch(cap),
  });
  assert.equal(cap.body.max_tokens, 321, 'normal model must use max_tokens');
  assert.ok(!('max_completion_tokens' in cap.body), 'normal model must NOT send max_completion_tokens');
});

// ── FIX 1 guard: openai_compat must NOT be changed ────────────────────────
test('openai_compat: o-series model still uses max_tokens (compat endpoints expect it)', async () => {
  const cap = {};
  const prov = makeOpenAICompatProvider({ name: 'groq', baseUrl: 'https://api.groq.com/openai/v1' });
  await drain(prov.sendMessage(
    [{ role: 'user', content: 'hi' }],
    { apiKey: 'k', model: 'o3-mini', fetch: makeStreamFetch(cap), maxTokens: 200 },
  ));
  assert.equal(cap.body.max_tokens, 200, 'compat provider must keep max_tokens');
  assert.ok(!('max_completion_tokens' in cap.body), 'compat provider must NOT send max_completion_tokens');
});

// ── FIX 2: run_turn threads cfg.maxTokens through to the provider ─────────
function makeRunTurnCtx(cfg) {
  let captured = null;
  const messages = [];
  const ctx = {
    cfg,
    cfgDir: '/tmp/lc-run-turn-test',
    sandboxSpec: null,
    syntheticChatSessionId: 'syn-1',
    getMessages: () => messages,
    getProv: () => ({
      name: 'openai',
      async *sendMessage(_msgs, opts) {
        captured = opts;
        // yield nothing — empty stream is enough to complete the turn
      },
    }),
    getActiveProvName: () => 'openai',
    getActiveModel: () => 'gpt-4.1',
    getSessionId: () => null,
    persistTurn: () => {},
    accumulateUsage: () => {},
    resolveAuthKey: () => 'k',
  };
  return { ctx, getCaptured: () => captured };
}

test('run_turn: passes opts.maxTokens when cfg.maxTokens is a positive number', async () => {
  const { ctx, getCaptured } = makeRunTurnCtx({ maxTokens: 16000 });
  const runTurn = makeRunTurn({ ctx, writeFn: () => {} });
  await runTurn('hi');
  assert.equal(getCaptured().maxTokens, 16000);
});

test('run_turn: omits opts.maxTokens when cfg.maxTokens is unset', async () => {
  const { ctx, getCaptured } = makeRunTurnCtx({});
  const runTurn = makeRunTurn({ ctx, writeFn: () => {} });
  await runTurn('hi');
  assert.ok(!('maxTokens' in getCaptured()), 'maxTokens must be omitted so DEFAULT_MAX_TOKENS applies');
});

test('run_turn: omits opts.maxTokens when cfg.maxTokens is not a positive finite number', async () => {
  for (const bad of [0, -1, NaN, Infinity, 'big', null]) {
    const { ctx, getCaptured } = makeRunTurnCtx({ maxTokens: bad });
    const runTurn = makeRunTurn({ ctx, writeFn: () => {} });
    await runTurn('hi');
    assert.ok(!('maxTokens' in getCaptured()), `maxTokens must be omitted for ${String(bad)}`);
  }
});
