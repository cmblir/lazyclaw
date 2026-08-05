// tests/f-live-model-lists-route.test.mjs — GET /providers must never block
// on the network and must always report `modelsSource` ('live'|'builtin')
// alongside `suggestedModels`. Exercises the real daemon route (startDaemon)
// so the wiring in daemon.mjs / daemon/routes/providers.mjs is covered, not
// just the underlying daemon/lib/model_cache.mjs unit.
//
// modelRefresh defaults to OFF (opt-in via ctx, like rateLimit/responseCache
// above it in daemon.mjs) specifically so these tests — and every other
// existing daemon test — never trigger a real network call from a
// background timer they didn't ask for. Tests that care about the 'live'
// tier turn it on explicitly with an injected fetchImpl.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startDaemon } from '../daemon.mjs';
import * as sessionsMod from '../sessions.mjs';

function tmpCfg(prefix = 'lc-models-route-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withDaemon(cfgDir, fn, extraOpts = {}, cfgOverrides = {}) {
  const cfg = { provider: 'mock', model: 'mock-model', ...cfgOverrides };
  const readConfig = () => cfg;
  const d = await startDaemon({
    readConfig,
    sessionsDirGetter: () => cfgDir,
    sessionsMod,
    version: () => 'test',
    port: 0,
    ...extraOpts,
  });
  try {
    await fn({ base: `http://127.0.0.1:${d.port}` });
  } finally {
    await d.close();
  }
}

test('GET /providers: every provider carries modelsSource, and it is always live or builtin', async () => {
  const cfgDir = tmpCfg();
  await withDaemon(cfgDir, async ({ base }) => {
    const r = await fetch(`${base}/providers`);
    assert.equal(r.status, 200);
    const arr = await r.json();
    assert.ok(Array.isArray(arr) && arr.length > 0);
    for (const p of arr) {
      assert.ok(['live', 'builtin'].includes(p.modelsSource), `${p.name}: unexpected modelsSource ${p.modelsSource}`);
      assert.ok(Array.isArray(p.suggestedModels), `${p.name}: suggestedModels must be an array`);
    }
  });
});

test('GET /providers: codex-cli reports more than one model from the committed generated file', async () => {
  // No modelRefresh here — this exercises the generated-file fallback tier
  // (providers/models.generated.mjs, produced by `npm run models:sync`)
  // exactly as a freshly booted daemon with no live cache yet would.
  const cfgDir = tmpCfg();
  await withDaemon(cfgDir, async ({ base }) => {
    const r = await fetch(`${base}/providers`);
    const arr = await r.json();
    const codex = arr.find((p) => p.name === 'codex-cli');
    assert.ok(codex, 'codex-cli must be registered');
    assert.ok(codex.suggestedModels.length > 1,
      `expected codex-cli to report more than one model; got ${JSON.stringify(codex.suggestedModels)}`);
    assert.equal(codex.modelsSource, 'builtin');
  });
});

test('GET /providers: responds quickly regardless of a hung background refresh', async () => {
  const cfgDir = tmpCfg();
  const neverSettles = () => new Promise(() => {}); // simulates an unreachable/hung provider
  await withDaemon(cfgDir, async ({ base }) => {
    const t0 = Date.now();
    const r = await fetch(`${base}/providers`);
    const elapsedMs = Date.now() - t0;
    assert.equal(r.status, 200);
    assert.ok(elapsedMs < 2000, `GET /providers took ${elapsedMs}ms — it must never wait on the network`);
  }, {
    modelRefresh: { initialDelayMs: 5, intervalMs: 1_000_000, fetchImpl: neverSettles },
  });
});

test('GET /providers: modelsSource flips to live once the background refresh populates the cache', async () => {
  const cfgDir = tmpCfg();
  // A fake authProfiles key for the built-in `openai` provider makes its
  // credential resolution deterministic regardless of the test machine's
  // real environment — no dependence on a real API key or a real CLI login.
  const fetchImpl = async (url) => {
    if (/api\.openai\.com\/v1\/models/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'fake-live-model' }] }) };
    }
    return { ok: false, status: 401, text: async () => 'unauthorized' };
  };
  await withDaemon(cfgDir, async ({ base }) => {
    // Give the (5ms-delayed) initial refresh time to land before asking.
    await new Promise((r) => setTimeout(r, 150));
    const r = await fetch(`${base}/providers`);
    const arr = await r.json();
    const openai = arr.find((p) => p.name === 'openai');
    assert.ok(openai, 'openai must be registered');
    assert.equal(openai.modelsSource, 'live');
    assert.deepEqual(openai.suggestedModels, ['fake-live-model']);
  }, {
    modelRefresh: { initialDelayMs: 5, intervalMs: 1_000_000, fetchImpl },
  }, {
    authProfiles: { openai: [{ label: 'test', key: 'sk-test-fake' }] },
  });
});
