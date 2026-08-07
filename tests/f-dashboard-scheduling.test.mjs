// tests/f-dashboard-scheduling.test.mjs — the dashboard Scheduling tab's daemon
// routes: GET /scheduling aggregates cron jobs (cfg.cron), durable goals, and
// loop runs; DELETE /cron/<name> removes a cron job (guarded by writeConfig).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as scheduling from '../daemon/routes/scheduling.mjs';
import * as cron from '../cron.mjs';
import { registerGoal } from '../goals.mjs';
import { writeMeta } from '../loops.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-sched-')); }
function mockRes() {
  return { code: 0, headers: null, body: null, writeHead(c, h) { this.code = c; this.headers = h; }, end(b) { this.body = b; } };
}

test('GET /scheduling aggregates cron jobs, goals, and loop runs', async () => {
  const dir = tmp();
  const store = { cfg: {} };
  cron.upsertJob(store.cfg, 'daily', '0 9 * * *', ['pompos', 'goal', 'tick', 'x']);
  registerGoal({ name: 'launch', schedule: '0 8 * * 1', description: 'ship it' }, dir);
  writeMeta('L1', { prompt: 'keep trying', status: 'completed', provider: 'mock', startedAt: '2026-06-29T00:00:00Z' }, dir);

  const res = mockRes();
  const ctx = { readConfig: () => store.cfg, writeConfig: (n) => { store.cfg = n; } };
  await scheduling.schedulingList({ ctx, gwConfigDir: dir, res });

  assert.equal(res.code, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.cron.length, 1);
  assert.equal(body.cron[0].name, 'daily');
  assert.equal(body.goals.length, 1);
  assert.equal(body.goals[0].name, 'launch');
  assert.equal(body.loops.length, 1);
  assert.equal(body.loops[0].status, 'completed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('DELETE /cron/<name> removes the job from config', async () => {
  const dir = tmp();
  const store = { cfg: {} };
  cron.upsertJob(store.cfg, 'nightly', '0 0 * * *', ['pompos', 'goal', 'tick', 'x']);
  assert.ok(store.cfg.cron.nightly);

  const res = mockRes();
  const ctx = { readConfig: () => store.cfg, writeConfig: (n) => { store.cfg = n; } };
  const url = new URL('http://127.0.0.1:19600/cron/nightly');
  await scheduling.cronDelete({ ctx, gwConfigDir: dir, res, url });

  assert.equal(res.code, 200);
  assert.equal(JSON.parse(res.body).removed, 'nightly');
  assert.ok(!store.cfg.cron.nightly, 'cron job removed from cfg');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('DELETE /cron/<name> refuses when the daemon is read-only (no writeConfig)', async () => {
  const res = mockRes();
  const ctx = { readConfig: () => ({}), writeConfig: undefined };
  const url = new URL('http://127.0.0.1:19600/cron/x');
  await scheduling.cronDelete({ ctx, gwConfigDir: tmp(), res, url });
  assert.equal(res.code, 405);
});

test('DELETE /cron/<unknown> is 404', async () => {
  const dir = tmp();
  const store = { cfg: { cron: {} } };
  const res = mockRes();
  const ctx = { readConfig: () => store.cfg, writeConfig: (n) => { store.cfg = n; } };
  const url = new URL('http://127.0.0.1:19600/cron/nope');
  await scheduling.cronDelete({ ctx, gwConfigDir: dir, res, url });
  assert.equal(res.code, 404);
  fs.rmSync(dir, { recursive: true, force: true });
});
