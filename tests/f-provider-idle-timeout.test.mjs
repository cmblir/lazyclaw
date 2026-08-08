// tests/f-provider-idle-timeout.test.mjs — FIX C1-provider-idle-timeout.
//
// Bug: no HTTP provider imposed any request timeout, so a hung connection
// or a stalled stream froze the turn forever (the user saw a frozen
// "thinking" with no exit but Ctrl-C). Each streaming provider now applies
// an IDLE (inter-chunk) timeout: it aborts only when NO chunk has arrived
// for N ms (the timer resets on every received chunk), so a long but
// healthy generation that streams steadily for minutes is never aborted.
//
// These tests inject a stub fetch returning a body stream we control:
//   (a) STALL: the stream yields one chunk then never the next. With a
//       short idle timeout it must reject with code TIMEOUT promptly.
//   (b) STEADY: the stream yields chunks with gaps SHORTER than the idle
//       window, for a total elapsed time LONGER than one idle window. It
//       must complete cleanly — this guards against a total-duration cap.
//
// anthropic is tested deeply; openai is a smoke check that the same idle
// behavior is wired there too.

import test from 'node:test';
import assert from 'node:assert/strict';
import { anthropicProvider } from '../providers/anthropic.mjs';
import { openaiProvider } from '../providers/openai.mjs';
import { geminiProvider } from '../providers/gemini.mjs';
import { ollamaProvider } from '../providers/ollama.mjs';
import { makeOpenAICompatProvider } from '../providers/openai_compat.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build an SSE response body (async generator of Uint8Array) whose chunk
// timing we control. `gaps` is the delay BEFORE each chunk; `frames` the
// SSE text for each chunk. If `hang` is true the generator awaits a
// never-resolving promise after the listed frames, simulating a stalled
// connection that never sends the next byte.
function makeTimedBody({ frames, gaps, hang = false }) {
  const enc = new TextEncoder();
  return (async function* () {
    for (let i = 0; i < frames.length; i++) {
      if (gaps[i]) await sleep(gaps[i]);
      yield enc.encode(frames[i]);
    }
    if (hang) {
      // Never resolves: the only way out is the idle timeout aborting us.
      await new Promise(() => {});
    }
  })();
}

function makeFetch(body) {
  return async function stubFetch() {
    return { ok: true, status: 200, headers: new Map(), body };
  };
}

async function drain(iter) {
  const out = [];
  for await (const t of iter) out.push(t);
  return out;
}

// Anthropic SSE frames.
const A_START = 'event: message_start\ndata: {"message":{"usage":{"input_tokens":1}}}\n\n';
const A_DELTA = (t) => `event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":${JSON.stringify(t)}}}\n\n`;
const A_STOP = 'event: message_stop\ndata: {}\n\n';

// ── (a) STALL must abort with code TIMEOUT within a bounded time ──────────
test('anthropic: stalled stream aborts with TIMEOUT after idle window', async () => {
  const body = makeTimedBody({
    frames: [A_START, A_DELTA('hi ')],
    gaps: [0, 0],
    hang: true, // first byte arrives, then the connection stalls forever
  });
  const started = Date.now();
  await assert.rejects(
    drain(anthropicProvider.sendMessage(
      [{ role: 'user', content: 'q' }],
      { apiKey: 'k', fetch: makeFetch(body), idleTimeoutMs: 60 },
    )),
    (err) => {
      assert.equal(err.code, 'TIMEOUT', `expected TIMEOUT, got ${err.code}: ${err.message}`);
      assert.match(err.message, /60/, 'message should mention the idle ms');
      return true;
    },
  );
  // Bounded: must give up well before any total-duration cap would.
  assert.ok(Date.now() - started < 2000, 'idle abort should be prompt');
});

// ── (b) STEADY stream longer than one idle window must NOT abort ──────────
test('anthropic: steady stream past one idle window completes (no total cap)', async () => {
  // 4 deltas with 40ms gaps = ~160ms total, each gap < 100ms idle window.
  const body = makeTimedBody({
    frames: [A_START, A_DELTA('a'), A_DELTA('b'), A_DELTA('c'), A_DELTA('d'), A_STOP],
    gaps: [0, 40, 40, 40, 40, 40],
    hang: false,
  });
  const out = await drain(anthropicProvider.sendMessage(
    [{ role: 'user', content: 'q' }],
    { apiKey: 'k', fetch: makeFetch(body), idleTimeoutMs: 100 },
  ));
  assert.deepEqual(out, ['a', 'b', 'c', 'd']);
});

// ── env var resolves the default when no opts override is given ───────────
test('anthropic: POMPOS_REQUEST_TIMEOUT_MS sets the idle window', async () => {
  const prev = process.env.POMPOS_REQUEST_TIMEOUT_MS;
  process.env.POMPOS_REQUEST_TIMEOUT_MS = '50';
  try {
    const body = makeTimedBody({ frames: [A_START], gaps: [0], hang: true });
    await assert.rejects(
      drain(anthropicProvider.sendMessage(
        [{ role: 'user', content: 'q' }],
        { apiKey: 'k', fetch: makeFetch(body) },
      )),
      (err) => err.code === 'TIMEOUT',
    );
  } finally {
    if (prev === undefined) delete process.env.POMPOS_REQUEST_TIMEOUT_MS;
    else process.env.POMPOS_REQUEST_TIMEOUT_MS = prev;
  }
});

// ── a user cancel still surfaces as ABORT, NOT TIMEOUT ────────────────────
test('anthropic: caller signal abort surfaces as ABORT, distinct from TIMEOUT', async () => {
  const ac = new AbortController();
  // Stream emits one chunk, then the caller aborts; the next loop pass must
  // throw ABORT (not the idle TIMEOUT) so the two stay distinguishable.
  const body = (async function* () {
    yield new TextEncoder().encode(A_START);
    ac.abort();
    yield new TextEncoder().encode(A_DELTA('x'));
  })();
  await assert.rejects(
    drain(anthropicProvider.sendMessage(
      [{ role: 'user', content: 'q' }],
      { apiKey: 'k', fetch: makeFetch(body), signal: ac.signal, idleTimeoutMs: 5000 },
    )),
    (err) => {
      assert.equal(err.code, 'ABORT', `expected ABORT, got ${err.code}`);
      return true;
    },
  );
});

// ── smoke: openai exposes the same idle-timeout behavior ──────────────────
test('openai (smoke): stalled stream aborts with TIMEOUT', async () => {
  const body = makeTimedBody({
    frames: ['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'],
    gaps: [0],
    hang: true,
  });
  await assert.rejects(
    drain(openaiProvider.sendMessage(
      [{ role: 'user', content: 'q' }],
      { apiKey: 'k', fetch: makeFetch(body), idleTimeoutMs: 60 },
    )),
    (err) => {
      assert.equal(err.code, 'TIMEOUT');
      return true;
    },
  );
});

test('openai (smoke): steady stream past one idle window completes', async () => {
  const body = makeTimedBody({
    frames: [
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"y"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"z"}}]}\n\n',
      'data: [DONE]\n\n',
    ],
    gaps: [0, 40, 40, 40],
    hang: false,
  });
  const out = await drain(openaiProvider.sendMessage(
    [{ role: 'user', content: 'q' }],
    { apiKey: 'k', fetch: makeFetch(body), idleTimeoutMs: 100 },
  ));
  assert.deepEqual(out, ['x', 'y', 'z']);
});

// ── smoke: gemini exposes the same idle-timeout behavior ──────────────────
test('gemini (smoke): stalled stream aborts with TIMEOUT', async () => {
  const body = makeTimedBody({
    frames: ['data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n'],
    gaps: [0],
    hang: true,
  });
  await assert.rejects(
    drain(geminiProvider.sendMessage(
      [{ role: 'user', content: 'q' }],
      { apiKey: 'k', fetch: makeFetch(body), idleTimeoutMs: 60 },
    )),
    (err) => err.code === 'TIMEOUT',
  );
});

// ── smoke: ollama exposes the same idle-timeout behavior ──────────────────
test('ollama (smoke): stalled stream aborts with TIMEOUT', async () => {
  const body = makeTimedBody({
    frames: ['{"message":{"content":"hi"},"done":false}\n'],
    gaps: [0],
    hang: true,
  });
  await assert.rejects(
    drain(ollamaProvider.sendMessage(
      [{ role: 'user', content: 'q' }],
      { fetch: makeFetch(body), idleTimeoutMs: 60 },
    )),
    (err) => err.code === 'TIMEOUT',
  );
});

// ── smoke: openai-compat factory exposes the same idle-timeout behavior ───
test('openai-compat (smoke): stalled stream aborts with TIMEOUT', async () => {
  const body = makeTimedBody({
    frames: ['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'],
    gaps: [0],
    hang: true,
  });
  const provider = makeOpenAICompatProvider({ name: 'test', baseUrl: 'https://x/v1', defaultModel: 'm' });
  await assert.rejects(
    drain(provider.sendMessage(
      [{ role: 'user', content: 'q' }],
      { apiKey: 'k', fetch: makeFetch(body), idleTimeoutMs: 60 },
    )),
    (err) => err.code === 'TIMEOUT',
  );
});
