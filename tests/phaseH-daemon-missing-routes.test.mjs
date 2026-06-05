// Phase H — Daemon dashboard surface (M12, M13, M14, m15, m16).
//
// The v5 dashboard expects a fleet of GETs the v4 daemon never shipped.
// This test exercises the in-process handler via startDaemon({port:0})
// so we can hit real routes without spawning a child CLI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startDaemon } from '../daemon.mjs';
import * as sessionsMod from '../sessions.mjs';

function tmpCfg(prefix = 'lc-daemon-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withDaemon(cfgDir, fn, cfgOverrides = {}) {
  let cfg = { provider: 'mock', model: 'mock-model', ...cfgOverrides };
  const cfgPath = path.join(cfgDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const readConfig = () => {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { return cfg; }
  };
  const writeConfig = (next) => {
    cfg = next;
    fs.writeFileSync(cfgPath, JSON.stringify(next));
  };
  // Point all the per-module config-dir env vars at the tmp cfg so
  // sessions / skills / agents land inside the sandbox.
  const prevEnv = process.env.LAZYCLAW_CONFIG_DIR;
  process.env.LAZYCLAW_CONFIG_DIR = cfgDir;
  const d = await startDaemon({
    readConfig,
    writeConfig,
    sessionsDirGetter: () => cfgDir,
    sessionsMod,
    version: () => 'test',
    port: 0,
  });
  const base = `http://127.0.0.1:${d.port}`;
  try {
    await fn({ base, cfgDir, readConfig, writeConfig });
  } finally {
    await d.close();
    if (prevEnv === undefined) delete process.env.LAZYCLAW_CONFIG_DIR;
    else process.env.LAZYCLAW_CONFIG_DIR = prevEnv;
  }
}

test('m15 — GET /healthz aliases GET /health', async () => {
  const cfgDir = tmpCfg();
  await withDaemon(cfgDir, async ({ base }) => {
    const a = await fetch(`${base}/health`);
    assert.equal(a.status, 200);
    const aJson = await a.json();
    assert.equal(aJson.ok, true);
    assert.equal(aJson.status, 'alive');

    const b = await fetch(`${base}/healthz`);
    assert.equal(b.status, 200);
    const bJson = await b.json();
    assert.equal(bJson.ok, true);
    assert.equal(bJson.status, 'alive');
  });
});

test('M12 — POST /providers {name:"test"} returns 400 reserved', async () => {
  const cfgDir = tmpCfg();
  await withDaemon(cfgDir, async ({ base }) => {
    const r = await fetch(`${base}/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'test', baseUrl: 'https://example.com' }),
    });
    assert.equal(r.status, 400, 'literal name "test" must be rejected as reserved');
    const j = await r.json();
    assert.match(j.error || '', /reserved/i, `expected reserved error, got: ${JSON.stringify(j)}`);
  });
});

test('M13 — PUT /agents/<unknown>/memory returns 404', async () => {
  const cfgDir = tmpCfg();
  await withDaemon(cfgDir, async ({ base }) => {
    const r = await fetch(`${base}/agents/nonexistent/memory`, {
      method: 'PUT',
      headers: { 'content-type': 'text/markdown' },
      body: 'should not write',
    });
    assert.equal(r.status, 404, 'unknown agent name → 404');
    const j = await r.json();
    assert.match(j.error || '', /no agent/i, `expected "no agent" error, got: ${JSON.stringify(j)}`);
  });
});

test('M13 — GET /agents/<unknown>/memory returns 404', async () => {
  const cfgDir = tmpCfg();
  await withDaemon(cfgDir, async ({ base }) => {
    const r = await fetch(`${base}/agents/nonexistent/memory`);
    assert.equal(r.status, 404, 'unknown agent name → 404');
  });
});

test('M14 — GET /recall returns FTS5 results (or empty hits on a fresh index)', async () => {
  const cfgDir = tmpCfg();
  await withDaemon(cfgDir, async ({ base }) => {
    const r = await fetch(`${base}/recall?q=hello&scope=all&k=5`);
    assert.equal(r.status, 200);
    const j = await r.json();
    // Shape — recall always returns query / hits / latencyMs.
    assert.ok(Object.prototype.hasOwnProperty.call(j, 'query'),
      `expected query field; got: ${JSON.stringify(j).slice(0, 200)}`);
    assert.ok(Array.isArray(j.hits), 'hits[] present');
  });
});

test('M14 — GET /sandbox returns profile array', async () => {
  const cfgDir = tmpCfg();
  await withDaemon(cfgDir, async ({ base }) => {
    const r = await fetch(`${base}/sandbox`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(Array.isArray(j.profiles), 'profiles[] present');
    assert.ok(j.profiles.length >= 1,
      `expected ≥1 backend profile; got ${j.profiles.length}`);
    assert.ok(typeof j.active === 'string', 'active backend name present');
  });
});

test('M14 — GET /channels returns enumerated channels block', async () => {
  const cfgDir = tmpCfg();
  await withDaemon(cfgDir, async ({ base }) => {
    const r = await fetch(`${base}/channels`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(Array.isArray(j.channels), 'channels[] present');
  });
});

test('M14 — GET /trainer/status returns cfg.trainer shape', async () => {
  const cfgDir = tmpCfg();
  await withDaemon(cfgDir, async ({ base }) => {
    const r = await fetch(`${base}/trainer/status`);
    assert.equal(r.status, 200);
    const j = await r.json();
    // Shape: provider/model/schedule/budget/recipe (any may be null when
    // the user hasn't set cfg.trainer.* yet — that's the freshness case).
    assert.ok(Object.prototype.hasOwnProperty.call(j, 'provider'));
    assert.ok(Object.prototype.hasOwnProperty.call(j, 'lastRunAt'));
  });
});

test('m16 — DELETE /sessions/<id> includes `removed: bool` in response', async () => {
  const cfgDir = tmpCfg();
  await withDaemon(cfgDir, async ({ base, cfgDir: dir }) => {
    // Seed a real session so we exercise the existed-before branch.
    sessionsMod.appendTurn('test-session', 'user', 'hi', dir);
    const r1 = await fetch(`${base}/sessions/test-session`, { method: 'DELETE' });
    assert.equal(r1.status, 200);
    const j1 = await r1.json();
    assert.equal(j1.ok, true);
    assert.equal(j1.removed, true,
      `seeded session must report removed:true; got: ${JSON.stringify(j1)}`);
    // Second delete on the same id — idempotent 200 with removed:false.
    const r2 = await fetch(`${base}/sessions/test-session`, { method: 'DELETE' });
    assert.equal(r2.status, 200);
    const j2 = await r2.json();
    assert.equal(j2.ok, true);
    assert.equal(j2.removed, false,
      `non-existent session must report removed:false; got: ${JSON.stringify(j2)}`);
  });
});
