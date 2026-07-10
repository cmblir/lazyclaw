// Phase 0 — error-taxonomy group.
//
// RELIABILITY DEFECT under test: the tool-use (agentic) adapters used to
// throw every HTTP failure as code:'HTTP_FAIL' with no numeric status, so
// providers/retry.mjs::isRetriableError returned false for transient 429/5xx
// on the agentic/team/orchestrator path — retries silently never triggered.
//
// These tests assert the tool-use adapters now classify HTTP status into the
// SAME codes the streaming providers use (RATE_LIMIT / OVERLOADED /
// SERVER_ERROR) and attach the numeric status, so isRetriableError recognizes
// them. INVALID_KEY/ABORT handling and the error-class shape must be untouched.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as anthropic from '../providers/tool_use/anthropic.mjs';
import * as openai from '../providers/tool_use/openai.mjs';
import * as gemini from '../providers/tool_use/gemini.mjs';
import { withRateLimitRetry } from '../providers/retry.mjs';

// isRetriableError is module-private; exercise it through the public wrapper.
// A synchronous throw before any chunk is yielded is exactly the callOnce
// HTTP-failure shape, so if the wrapper retries then the error was retriable.
async function isRetriedByWrapper(err) {
  let calls = 0;
  const provider = {
    name: 'fake',
    // eslint-disable-next-line require-yield
    async *sendMessage() {
      calls++;
      throw err;
    },
  };
  const wrapped = withRateLimitRetry(provider, {
    attempts: 1,
    sleep: async () => {},
  });
  try {
    // eslint-disable-next-line no-empty
    for await (const _ of wrapped.sendMessage([], {})) {}
  } catch { /* expected: exhausts and rethrows */ }
  // >1 call means the wrapper decided the error was retriable.
  return calls > 1;
}

// Build a fake fetch that returns a non-ok Response with the given status.
function fetchWithStatus(status, bodyText = 'transient upstream error') {
  return async () => ({
    ok: false,
    status,
    async text() { return bodyText; },
  });
}

const ADAPTERS = [
  { name: 'anthropic', mod: anthropic },
  { name: 'openai', mod: openai },
  { name: 'gemini', mod: gemini },
];

for (const { name, mod } of ADAPTERS) {
  test(`${name} tool-use: HTTP 429 -> RATE_LIMIT + status 429 + retriable`, async () => {
    let thrown;
    try {
      await mod.callOnce({
        messages: [{ role: 'user', content: 'hi' }],
        apiKey: 'k',
        fetchImpl: fetchWithStatus(429),
      });
    } catch (e) { thrown = e; }
    assert.ok(thrown, 'expected callOnce to throw on HTTP 429');
    assert.equal(thrown.code, 'RATE_LIMIT');
    assert.equal(thrown.status, 429);
    assert.equal(await isRetriedByWrapper(thrown), true);
  });

  test(`${name} tool-use: HTTP 503 -> SERVER_ERROR + status 503 + retriable`, async () => {
    let thrown;
    try {
      await mod.callOnce({
        messages: [{ role: 'user', content: 'hi' }],
        apiKey: 'k',
        fetchImpl: fetchWithStatus(503),
      });
    } catch (e) { thrown = e; }
    assert.ok(thrown, 'expected callOnce to throw on HTTP 503');
    assert.equal(thrown.code, 'SERVER_ERROR');
    assert.equal(thrown.status, 503);
    assert.equal(await isRetriedByWrapper(thrown), true);
  });

  test(`${name} tool-use: HTTP 529 -> OVERLOADED + status 529 + retriable`, async () => {
    let thrown;
    try {
      await mod.callOnce({
        messages: [{ role: 'user', content: 'hi' }],
        apiKey: 'k',
        fetchImpl: fetchWithStatus(529),
      });
    } catch (e) { thrown = e; }
    assert.ok(thrown, 'expected callOnce to throw on HTTP 529');
    assert.equal(thrown.code, 'OVERLOADED');
    assert.equal(thrown.status, 529);
    assert.equal(await isRetriedByWrapper(thrown), true);
  });

  test(`${name} tool-use: HTTP 400 stays non-retriable (caller fault)`, async () => {
    let thrown;
    try {
      await mod.callOnce({
        messages: [{ role: 'user', content: 'hi' }],
        apiKey: 'k',
        fetchImpl: fetchWithStatus(400),
      });
    } catch (e) { thrown = e; }
    assert.ok(thrown, 'expected callOnce to throw on HTTP 400');
    assert.equal(thrown.status, 400);
    assert.notEqual(thrown.code, 'RATE_LIMIT');
    assert.notEqual(thrown.code, 'SERVER_ERROR');
    assert.notEqual(thrown.code, 'OVERLOADED');
    assert.equal(await isRetriedByWrapper(thrown), false);
  });

  test(`${name} tool-use: error class shape stays backward compatible`, async () => {
    let thrown;
    try {
      await mod.callOnce({
        messages: [{ role: 'user', content: 'hi' }],
        apiKey: 'k',
        fetchImpl: fetchWithStatus(429, 'body-text'),
      });
    } catch (e) { thrown = e; }
    // message + body fields preserved as before.
    assert.match(thrown.message, /HTTP 429/);
    assert.equal(thrown.body, 'body-text');
    assert.ok(thrown instanceof Error);
  });
}
