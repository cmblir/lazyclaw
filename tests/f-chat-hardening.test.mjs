// tests/f-chat-hardening.test.mjs — two reliability fixes for the chat path.
//
// FIX 1 (providers/retry.mjs): withRateLimitRetry must also retry transient
//   server-overload / 5xx errors that surface BEFORE the first chunk — not
//   just code === 'RATE_LIMIT'. Anthropic's 529 overloaded_error and generic
//   5xx used to bubble straight to the caller. A MID-STREAM error is still
//   never retried (would duplicate output), and 4xx other than 429 still
//   bubble unchanged.
//
// FIX 2 (commands/chat.mjs): the interactive provider is wrapped with
//   withRateLimitRetry so a transient 429/529 in chat is retried instead of
//   printing "error: ...". Exercised in-process with a stub provider injected
//   into the registry and a fake non-TTY stdin.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { withRateLimitRetry } from '../providers/retry.mjs';

const noSleep = async () => {}; // make retries instant in tests

// A provider stub that throws `err` on the first N attempts (before any
// chunk), then streams `reply`. `attemptsSeen` records each sendMessage call.
function makeFlakyProvider({ err, failTimes = 1, reply = 'ok', attemptsSeen }) {
  let calls = 0;
  return {
    name: 'flaky',
    async *sendMessage() {
      const n = ++calls;
      attemptsSeen?.push(n);
      if (n <= failTimes) throw err;
      yield reply;
    },
  };
}

test('FIX1: retries a 529/OVERLOADED thrown before any chunk, then succeeds', async () => {
  const seen = [];
  const overloaded = Object.assign(new Error('overloaded_error'), { code: 'OVERLOADED', status: 529 });
  const base = makeFlakyProvider({ err: overloaded, failTimes: 1, reply: 'recovered', attemptsSeen: seen });
  const wrapped = withRateLimitRetry(base, { attempts: 3, sleep: noSleep });

  const chunks = [];
  for await (const c of wrapped.sendMessage([{ role: 'user', content: 'hi' }])) chunks.push(c);

  assert.deepEqual(seen, [1, 2], 'should make a second attempt after the 529');
  assert.deepEqual(chunks, ['recovered'], 'second attempt streamed the reply');
});

test('FIX1: retries a generic 5xx (status>=500) before the first chunk', async () => {
  const seen = [];
  const serverErr = Object.assign(new Error('bad gateway'), { status: 502 });
  const base = makeFlakyProvider({ err: serverErr, failTimes: 1, reply: 'ok', attemptsSeen: seen });
  const wrapped = withRateLimitRetry(base, { attempts: 3, sleep: noSleep });

  const chunks = [];
  for await (const c of wrapped.sendMessage([{ role: 'user', content: 'hi' }])) chunks.push(c);

  assert.deepEqual(seen, [1, 2], '5xx before first chunk must be retried');
  assert.deepEqual(chunks, ['ok']);
});

test('FIX1: still RATE_LIMIT retries (regression guard)', async () => {
  const seen = [];
  const rl = Object.assign(new Error('rate limited'), { code: 'RATE_LIMIT', retryAfterMs: 0 });
  const base = makeFlakyProvider({ err: rl, failTimes: 1, reply: 'ok', attemptsSeen: seen });
  const wrapped = withRateLimitRetry(base, { attempts: 3, sleep: noSleep });
  const chunks = [];
  for await (const c of wrapped.sendMessage([{ role: 'user', content: 'hi' }])) chunks.push(c);
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(chunks, ['ok']);
});

test('FIX1: does NOT retry a mid-stream error (would duplicate output)', async () => {
  let calls = 0;
  const base = {
    name: 'midstream',
    async *sendMessage() {
      calls++;
      yield 'partial';
      const e = Object.assign(new Error('overloaded'), { code: 'OVERLOADED', status: 529 });
      throw e;
    },
  };
  const wrapped = withRateLimitRetry(base, { attempts: 3, sleep: noSleep });
  const chunks = [];
  await assert.rejects(async () => {
    for await (const c of wrapped.sendMessage([{ role: 'user', content: 'hi' }])) chunks.push(c);
  }, /overloaded/);
  assert.equal(calls, 1, 'mid-stream error must not trigger a retry');
  assert.deepEqual(chunks, ['partial']);
});

test('FIX1: does NOT retry a non-429 4xx (e.g. 400)', async () => {
  const seen = [];
  const badReq = Object.assign(new Error('bad request'), { status: 400 });
  const base = makeFlakyProvider({ err: badReq, failTimes: 5, attemptsSeen: seen });
  const wrapped = withRateLimitRetry(base, { attempts: 3, sleep: noSleep });
  await assert.rejects(async () => {
    for await (const _ of wrapped.sendMessage([{ role: 'user', content: 'hi' }])) { /* drain */ }
  }, /bad request/);
  assert.deepEqual(seen, [1], '4xx (other than 429) must bubble without retry');
});

// ── FIX 2: chat.mjs wraps the interactive provider with retry ──────────────

function tmpConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-chat-harden-'));
}

// Drive cmdChat's legacy (non-Ink) readline path in-process with a fake
// non-TTY stdin that feeds one user line + EOF, capturing stdout.
async function runChatTurn(prompt) {
  const realStdin = process.stdin;
  const realWrite = process.stdout.write.bind(process.stdout);
  let out = '';
  const fake = Readable.from([`${prompt}\n`]);
  fake.isTTY = false;
  fake.setRawMode = undefined;
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
  process.stdout.write = (s) => { out += String(s); return true; };
  try {
    const { cmdChat } = await import('../commands/chat.mjs');
    await cmdChat({});
  } finally {
    process.stdout.write = realWrite;
    Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
  }
  return out;
}

test('FIX2: chat wraps the interactive provider so a transient 529 is retried', async () => {
  const dir = tmpConfigDir();
  process.env.LAZYCLAW_CONFIG_DIR = dir;
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ provider: 'flaky529', model: 'm1' }),
    { mode: 0o600 },
  );

  const { ensureRegistry } = await import('../lib/registry_boot.mjs');
  const reg = await ensureRegistry();
  // Inject a provider that 529s on the first attempt (retryAfterMs:0 keeps the
  // backoff instant) then streams. If chat left prov UNWRAPPED, run_turn would
  // write "error: ..." and the reply text would never appear.
  let calls = 0;
  reg.PROVIDERS.flaky529 = {
    name: 'flaky529',
    async *sendMessage() {
      if (++calls === 1) {
        throw Object.assign(new Error('overloaded_error'), { code: 'OVERLOADED', status: 529, retryAfterMs: 0 });
      }
      yield 'RECOVERED_REPLY';
    },
  };

  try {
    const out = await runChatTurn('hello');
    assert.equal(calls >= 2, true, `provider should be retried (calls=${calls}); out=${out}`);
    assert.match(out, /RECOVERED_REPLY/, `retried reply must reach stdout; got: ${out}`);
    assert.doesNotMatch(out, /error: overloaded/, 'transient error must not surface as a chat error');
  } finally {
    delete reg.PROVIDERS.flaky529;
    delete process.env.LAZYCLAW_CONFIG_DIR;
  }
});
