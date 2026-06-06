// tests/p3-loop-abort.test.mjs — P3 restore: the Ink /loop created an inert
// AbortController, so Ctrl-C/Esc couldn't stop a running loop. It now uses the
// abort signal the REPL threads in via ctx.loopSignal, so the host's
// interrupt aborts the loop.

import test from 'node:test';
import assert from 'node:assert/strict';

import { dispatchSlash } from '../tui/slash_dispatcher.mjs';

function makeCtx({ signal }) {
  let calls = 0;
  const prov = {
    async *sendMessage() { calls += 1; yield 'ok'; },
  };
  return {
    _calls: () => calls,
    cfgDir: '/tmp',
    loopSignal: signal,
    getMessages: () => [],
    setMessages: () => {},
    getProv: () => prov,
    getActiveProvName: () => 'mock',
    getActiveModel: () => 'mock',
    resolveAuthKey: () => '',
    accumulateUsage: () => {},
    persistTurn: () => {},
    getSessionId: () => null,
    getCharsSent: () => 0,
    setCharsSent: () => {},
  };
}

test('/loop honors a pre-aborted ctx.loopSignal and stops immediately', async () => {
  const ac = new AbortController();
  ac.abort();
  const ctx = makeCtx({ signal: ac.signal });
  const out = await dispatchSlash('/loop', 'ping --max 5', ctx, () => {});
  assert.match(out, /abort/i);
  assert.ok(ctx._calls() === 0, `aborted loop should not call the provider, got ${ctx._calls()}`);
});

test('/loop without an abort runs to --max', async () => {
  const ctx = makeCtx({ signal: undefined });
  const out = await dispatchSlash('/loop', 'ping --max 2', ctx, () => {});
  assert.match(out, /loop done — 2\/2/);
  assert.equal(ctx._calls(), 2);
});
