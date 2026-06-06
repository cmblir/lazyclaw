// tests/p3-goal-cron-dispatch.test.mjs — P3 restore: /goal add --cron attaches
// a schedule from the Ink chat and /goal close detaches it. LAZYCLAW_SKIP_CRON
// _INSTALL keeps the test off the real launchd/crontab backend.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { dispatchSlash } from '../tui/slash_dispatcher.mjs';

process.env.LAZYCLAW_SKIP_CRON_INSTALL = '1';

function makeCtx() {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-goalcron-'));
  let store = {};
  return {
    cfgDir,
    cfg: {},
    readConfig: () => JSON.parse(JSON.stringify(store)),
    writeConfig: (c) => { store = JSON.parse(JSON.stringify(c)); },
    getMessages: () => [],
    setMessages: () => {},
    getActiveProvName: () => 'mock',
    getActiveModel: () => 'mock',
    _peek: () => store,
  };
}

test('/goal add --cron records the schedule in cfg.cron', async () => {
  const ctx = makeCtx();
  const out = await dispatchSlash('/goal', 'add sweep --cron "0 9 * * *"', ctx);
  assert.match(out, /goal sweep added/);
  assert.match(out, /cron/);
  assert.ok(ctx._peek().cron && ctx._peek().cron['goal-sweep'], 'cron job persisted');
  assert.equal(ctx._peek().cron['goal-sweep'].schedule, '0 9 * * *');
});

test('/goal close detaches the cron job', async () => {
  const ctx = makeCtx();
  await dispatchSlash('/goal', 'add sweep --cron "*/5 * * * *"', ctx);
  assert.ok(ctx._peek().cron['goal-sweep']);
  const out = await dispatchSlash('/goal', 'close sweep', ctx);
  assert.match(out, /closed/);
  assert.match(out, /cron detached/);
  assert.equal(ctx._peek().cron['goal-sweep'], undefined);
});
