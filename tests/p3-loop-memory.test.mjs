// tests/p3-loop-memory.test.mjs — P3 restore: /loop --memory / --recall used
// to rebuild the system message from core memory each iteration; the v5.4 Ink
// _loop parsed the flags but ignored them (silent no-op). This restores the
// per-iteration buildSystem and the post-loop system restore.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { dispatchSlash } from '../tui/slash_dispatcher.mjs';
import { setCore } from '../memory.mjs';

function makeCtx({ cfgDir, initialMessages = [] }) {
  let messages = initialMessages.slice();
  const captured = [];
  const prov = {
    // captures the system message each turn sees, then yields an empty reply
    async *sendMessage(msgs) {
      const sys = (msgs.find((m) => m.role === 'system') || {}).content || null;
      captured.push(sys);
      yield '';
    },
  };
  return {
    captured,
    cfgDir,
    getMessages: () => messages,
    setMessages: (n) => { messages = n; },
    getProv: () => prov,
    getActiveProvName: () => 'mock',
    getActiveModel: () => 'mock',
    resolveAuthKey: () => '',
    accumulateUsage: () => {},
    persistTurn: () => {},
    getSessionId: () => null,
    getCharsSent: () => 0,
    setCharsSent: () => {},
    _messages: () => messages,
  };
}

test('/loop --memory injects core memory into the per-iteration system', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-loopmem-'));
  setCore('CORE-MEMORY-XYZ', cfgDir);
  const ctx = makeCtx({ cfgDir });
  const out = await dispatchSlash('/loop', 'ping --max 1 --use-memory', ctx);
  assert.match(out, /loop done/);
  assert.equal(ctx.captured.length, 1);
  assert.match(ctx.captured[0], /CORE-MEMORY-XYZ/);
});

test('/loop without --memory does NOT inject core memory', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-loopmem-'));
  setCore('CORE-MEMORY-XYZ', cfgDir);
  const ctx = makeCtx({ cfgDir });
  await dispatchSlash('/loop', 'ping --max 1', ctx);
  assert.equal(ctx.captured[0], null, 'no system injected without --memory');
});

test('/loop --memory restores the prior chat system message afterwards', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-loopmem-'));
  setCore('CORE-MEMORY-XYZ', cfgDir);
  const ctx = makeCtx({ cfgDir, initialMessages: [{ role: 'system', content: 'ORIG-SYS' }] });
  await dispatchSlash('/loop', 'ping --max 1 --use-memory', ctx);
  // during the loop the system was core + ORIG-SYS
  assert.match(ctx.captured[0], /CORE-MEMORY-XYZ/);
  assert.match(ctx.captured[0], /ORIG-SYS/);
  // after the loop, the original system is restored
  const sys = ctx._messages().find((m) => m.role === 'system');
  assert.equal(sys.content, 'ORIG-SYS');
});
