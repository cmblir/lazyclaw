// tests/f-slash-sse.test.mjs — long commands must show progress as it happens.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeSlashRunner, STREAMING } from '../daemon/lib/slash_http.mjs';
import { makeConfirmStore } from '../daemon/lib/confirm_tokens.mjs';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-slash-sse-'));
process.env.POMPOS_CONFIG_DIR = CFG;
after(() => fs.rmSync(CFG, { recursive: true, force: true }));

test('STREAMING names the commands that can run long', () => {
  assert.ok(STREAMING.has('/loop'), '/loop runs until stopped');
  assert.ok(STREAMING.size > 0);
  assert.equal(STREAMING.has('/status'), false, 'instant commands stay buffered');
});

test('runStreaming delivers each line as it is produced, not at the end', async () => {
  const seen = [];
  let resolveSecond;
  const gate = new Promise((r) => { resolveSecond = r; });
  const runner = makeSlashRunner({
    cfgDir: CFG, confirmStore: makeConfirmStore(),
    dispatch: async (_c, _a, _ctx, write) => {
      write('step one\n');
      // The test only proceeds once the first line has been observed, which
      // is impossible if lines are buffered until the handler returns.
      await gate;
      write('step two\n');
      return 'finished';
    },
  });
  const done = runner.runStreaming({
    line: '/loop',
    onLine: (l) => { seen.push(l); if (seen.length === 1) resolveSecond(); },
  });
  const out = await done;
  assert.deepEqual(seen, ['step one\n', 'step two\n', 'finished']);
  assert.deepEqual(out, { ok: true, lines: ['step one\n', 'step two\n', 'finished'] });
});

test('a streaming command still honours the confirmation gate', async () => {
  let ran = false;
  const runner = makeSlashRunner({
    cfgDir: CFG, confirmStore: makeConfirmStore(),
    dispatch: async () => { ran = true; return 'x'; },
  });
  const out = await runner.runStreaming({ line: '/clear', onLine: () => {} });
  assert.equal(out.code, 'CONFIRM_REQUIRED');
  assert.equal(ran, false, 'confirmation precedes streaming, same as the buffered path');
});

test('a thrown handler ends the stream with an error envelope', async () => {
  const runner = makeSlashRunner({
    cfgDir: CFG, confirmStore: makeConfirmStore(),
    dispatch: async (_c, _a, _ctx, write) => { write('partial\n'); throw new Error('boom'); },
  });
  const seen = [];
  const out = await runner.runStreaming({ line: '/loop', onLine: (l) => seen.push(l) });
  assert.deepEqual(seen, ['partial\n'], 'what was produced before the failure still reached the client');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'SLASH_ERR');
  assert.match(out.error, /boom/);
});
