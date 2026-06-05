// v5 Group C (C7) — shared makeRunTurn() factory tests.
//
// The factory backs BOTH the ink REPL path and the legacy readline
// path in cli.mjs. One factory ⇒ one set of bugs. These tests pin the
// contract the chat REPL depends on:
//   1. provider stream is forwarded into writeFn + accumulated into the
//      assistant message;
//   2. persistTurn is called twice (user + assistant);
//   3. a pre-aborted signal returns immediately, no provider call;
//   4. post-task learning hook fires once per successful turn (via
//      queueMicrotask — best-effort, never blocks the next prompt);
//   5. provider abort mid-stream drops the partial assistant message
//      (does NOT push half a reply into messages).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRunTurn } from '../tui/run_turn.mjs';

function tmpCfg() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-runturn-'));
}

function makeMockProvider({ reply = 'hello world', delayMs = 0, observe = {} } = {}) {
  return {
    name: 'mock',
    async *sendMessage(messages, opts = {}) {
      // Snapshot (deep copy) so the test sees what the provider received
      // at call time, not the post-turn mutated array.
      observe.lastMessages = messages.map((m) => ({ ...m }));
      observe.lastOpts = opts;
      observe.callCount = (observe.callCount || 0) + 1;
      for (const ch of reply) {
        if (opts.signal?.aborted) {
          const e = new Error('aborted');
          e.code = 'ABORT';
          throw e;
        }
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        yield ch;
      }
    },
  };
}

function makeCtx({ provider, messages = [], cfgDir }) {
  return {
    cfg: { provider: 'mock', model: 'mock-m' },
    cfgDir,
    sandboxSpec: null,
    syntheticChatSessionId: 'chat-test-1',
    getMessages: () => messages,
    getProv: () => provider,
    getActiveProvName: () => 'mock',
    getActiveModel: () => 'mock-m',
    getSessionId: () => null, // unsessioned chat (memory-only persist)
    persistTurn: () => {},
    accumulateUsage: () => {},
    resolveAuthKey: () => '',
  };
}

test('C7 — makeRunTurn streams provider output into writeFn + accumulates assistant message', async () => {
  const cfgDir = tmpCfg();
  const messages = [];
  const observe = {};
  const provider = makeMockProvider({ reply: 'hello', observe });
  const writes = [];
  const ctx = makeCtx({ provider, messages, cfgDir });
  const runTurn = makeRunTurn({ ctx, writeFn: (chunk) => writes.push(chunk) });

  await runTurn('hi', new AbortController().signal);

  // Drain the 30 ms buffered writer.
  await new Promise((r) => setTimeout(r, 50));

  // Provider was called with the user message in tail position.
  assert.equal(observe.callCount, 1);
  assert.deepEqual(
    observe.lastMessages[observe.lastMessages.length - 1],
    { role: 'user', content: 'hi' },
  );
  // Reply was buffered+flushed to writeFn; trailing '\n' too.
  const concat = writes.join('');
  assert.ok(concat.startsWith('hello'), `expected reply prefix 'hello', got: ${JSON.stringify(concat)}`);
  assert.ok(concat.endsWith('\n'), `expected trailing newline, got: ${JSON.stringify(concat)}`);
  // messages now has user + assistant (no system was provided).
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { role: 'user', content: 'hi' });
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].content, 'hello');
});

test('C7 — persistTurn is called once for the user and once for the assistant', async () => {
  const cfgDir = tmpCfg();
  const messages = [];
  const persistCalls = [];
  const ctx = {
    ...makeCtx({ provider: makeMockProvider({ reply: 'ok' }), messages, cfgDir }),
    persistTurn: (role, content) => persistCalls.push({ role, content }),
  };
  const runTurn = makeRunTurn({ ctx, writeFn: () => {} });

  await runTurn('ping', new AbortController().signal);
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(persistCalls.length, 2, `expected 2 persistTurn calls, got ${persistCalls.length}`);
  assert.deepEqual(persistCalls[0], { role: 'user', content: 'ping' });
  assert.equal(persistCalls[1].role, 'assistant');
  assert.equal(persistCalls[1].content, 'ok');
});

test('C7 — runTurn returns immediately when signal already aborted (no provider call)', async () => {
  const cfgDir = tmpCfg();
  const messages = [];
  const observe = {};
  const provider = makeMockProvider({ reply: 'should-not-stream', observe });
  const ctx = makeCtx({ provider, messages, cfgDir });
  const runTurn = makeRunTurn({ ctx, writeFn: () => {} });

  const ac = new AbortController();
  ac.abort(); // pre-abort before runTurn is called

  await runTurn('skipped', ac.signal);

  // Provider must not have been called.
  assert.equal(observe.callCount || 0, 0, 'pre-aborted signal must skip provider.sendMessage entirely');
  // messages must remain untouched (no user push, no assistant push).
  assert.equal(messages.length, 0);
});

test('C7 — post-task learning hook is invoked once via queueMicrotask after a successful turn', async () => {
  // Stub the learning import by intercepting via a fake provider that
  // observes whether runLearning is reached. Easier path: invoke
  // runTurn with a tmp cfgDir and let runLearning('post-task') write
  // a trajectory record; assert the record exists. trajectory_store
  // is the durable side-effect of the hook; if the trajectory file
  // shows up, the hook fired.
  const cfgDir = tmpCfg();
  const messages = [];
  const provider = makeMockProvider({ reply: 'hello' });
  const ctx = makeCtx({ provider, messages, cfgDir });
  // Inject a known sessionId so listByTaskId can find it.
  ctx.getSessionId = () => 'task-runturn-1';

  const runTurn = makeRunTurn({ ctx, writeFn: () => {} });
  await runTurn('hi there', new AbortController().signal);

  // queueMicrotask deferred; give the dynamic import + I/O a moment.
  await new Promise((r) => setTimeout(r, 300));

  const trajectoryStore = await import('../mas/trajectory_store.mjs');
  const records = await trajectoryStore.listByTaskId('task-runturn-1', { configDir: cfgDir });
  assert.ok(
    records.length >= 1,
    `expected at least one trajectory record from the post-task learning hook, got ${records.length}`,
  );
});

test('C7 — provider abort mid-stream does NOT push a partial assistant message', async () => {
  const cfgDir = tmpCfg();
  const messages = [];
  const observe = {};
  // 5ms-per-char so we have time to abort mid-stream.
  const provider = makeMockProvider({ reply: 'abcdefghij', delayMs: 5, observe });
  const ctx = makeCtx({ provider, messages, cfgDir });
  const runTurn = makeRunTurn({ ctx, writeFn: () => {} });

  const ac = new AbortController();
  const p = runTurn('start', ac.signal);
  // Abort after ~10 ms so we get a partial reply.
  setTimeout(() => ac.abort(), 10);
  await p;
  // Drain any pending flush.
  await new Promise((r) => setTimeout(r, 50));

  // The user message must have been pushed (turn started) ...
  assert.equal(messages[0]?.role, 'user');
  assert.equal(messages[0]?.content, 'start');
  // ... but no assistant message should have been appended (partial reply dropped).
  const assistantPushes = messages.filter((m) => m.role === 'assistant');
  assert.equal(
    assistantPushes.length,
    0,
    `expected zero assistant pushes after abort, got ${assistantPushes.length}`,
  );
});
