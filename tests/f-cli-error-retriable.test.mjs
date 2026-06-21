// tests/f-cli-error-retriable.test.mjs
//
// claude-cli / codex-cli / gemini-cli surface upstream throttling by exiting
// non-zero with the throttle text on stderr (e.g. claude's "Server temporarily
// limiting requests (not your usage limit)"). Those exits used to map to a
// generic, NON-retriable CLI_EXIT code, so a transient throttle failed hard
// instead of being retried — the exact failure mode that broke a fan-out of
// claude-cli agents mid-run. classifyCliExit maps transient throttles to a
// retriable RATE_LIMIT while keeping genuine, durable usage caps non-retriable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCliExit } from '../providers/cli_error.mjs';
import { withRateLimitRetry } from '../providers/retry.mjs';

test('transient throttle stderr classifies as retriable RATE_LIMIT', () => {
  const c = classifyCliExit('Server temporarily limiting requests (not your usage limit). Rate limited.');
  assert.equal(c.code, 'RATE_LIMIT');
  assert.equal(c.retriable, true);
});

test('overloaded / 429 / 503 stderr is retriable', () => {
  assert.equal(classifyCliExit('Error: overloaded_error').code, 'RATE_LIMIT');
  assert.equal(classifyCliExit('HTTP 429 Too Many Requests').code, 'RATE_LIMIT');
  assert.equal(classifyCliExit('upstream returned 503 service unavailable').code, 'RATE_LIMIT');
});

test('a genuine usage cap is NOT retriable (hard fail)', () => {
  // The transient text literally says "...not your usage limit..." — the cap
  // match must NOT fire on that, only on real cap wording.
  assert.equal(classifyCliExit("You've reached your usage limit. Upgrade your plan.").code, 'CLI_EXIT');
  assert.equal(classifyCliExit('Out of credits').code, 'CLI_EXIT');
  assert.equal(classifyCliExit('quota exceeded for this month').code, 'CLI_EXIT');
});

test('an unrelated CLI failure stays non-retriable', () => {
  assert.equal(classifyCliExit('ENOENT: no such file or directory').code, 'CLI_EXIT');
  assert.equal(classifyCliExit('').code, 'CLI_EXIT');
  assert.equal(classifyCliExit(null).code, 'CLI_EXIT');
});

test('a throttle-coded error is actually retried by withRateLimitRetry', async () => {
  let calls = 0;
  const base = {
    name: 'fake-cli',
    async *sendMessage() {
      calls++;
      if (calls === 1) {
        const e = new Error('claude CLI exited 1: Server temporarily limiting requests');
        e.code = classifyCliExit('Server temporarily limiting requests').code; // RATE_LIMIT
        e.retryAfterMs = 1;
        throw e;
      }
      yield 'ok';
    },
  };
  const wrapped = withRateLimitRetry(base, { attempts: 2, sleep: async () => {} });
  let out = '';
  for await (const c of wrapped.sendMessage([], {})) out += c;
  assert.equal(out, 'ok');
  assert.equal(calls, 2, 'should retry once after the throttle then succeed');
});
