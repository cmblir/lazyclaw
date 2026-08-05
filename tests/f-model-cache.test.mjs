// tests/f-model-cache.test.mjs — daemon/lib/model_cache.mjs: the live
// model-list cache GET /providers reads synchronously, its TTL, the
// live -> generated -> static resolution order, and the background refresh
// loop's timer hygiene (unref'd, independent-per-provider updates).
//
// No network: every test injects its own fetchImpl/providers/providerInfo.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createModelListCache,
  resolveModelsForProvider,
  refreshModelCache,
  startModelRefreshLoop,
} from '../daemon/lib/model_cache.mjs';

function jsonResp(obj) {
  return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
}

// ─── createModelListCache ───────────────────────────────────────────────────

test('createModelListCache: set/get round-trips, including an empty (but present) list', () => {
  const cache = createModelListCache();
  cache.set('p', ['m1', 'm2']);
  assert.deepEqual(cache.get('p'), ['m1', 'm2']);
  cache.set('empty-but-live', []);
  assert.deepEqual(cache.get('empty-but-live'), [], 'a live empty result is a real answer, not "missing"');
  assert.equal(cache.get('never-set'), undefined);
});

test('createModelListCache: an entry older than ttlMs is treated as absent and evicted', async () => {
  const cache = createModelListCache({ ttlMs: 10 });
  cache.set('p', ['m1']);
  assert.deepEqual(cache.get('p'), ['m1']);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(cache.get('p'), undefined, 'stale entry must read back as absent');
  assert.equal(cache.size(), 0, 'stale entry must be evicted on read, not just hidden');
});

// ─── resolveModelsForProvider ───────────────────────────────────────────────

test('resolveModelsForProvider: a live cache hit wins, even when the live list is empty', () => {
  const cache = createModelListCache();
  cache.set('gemini-cli', []);
  const r = resolveModelsForProvider('gemini-cli', {
    cache,
    generated: { 'gemini-cli': { models: ['stale-override'], fetchedAt: 't', provenance: 'live' } },
    providerInfo: { 'gemini-cli': { suggestedModels: ['static-override'] } },
  });
  assert.deepEqual(r, { models: [], source: 'live' });
});

test('resolveModelsForProvider: no live entry -> falls through to a non-empty generated entry', () => {
  const r = resolveModelsForProvider('codex-cli', {
    cache: createModelListCache(),
    generated: { 'codex-cli': { models: ['gpt-x', 'gpt-y'], fetchedAt: 't', provenance: 'live' } },
    providerInfo: { 'codex-cli': { suggestedModels: ['gpt-5.5'] } },
  });
  assert.deepEqual(r, { models: ['gpt-x', 'gpt-y'], source: 'builtin' });
});

test('resolveModelsForProvider: an empty generated entry is skipped in favor of the static suggestedModels', () => {
  const r = resolveModelsForProvider('gemini-cli', {
    cache: createModelListCache(),
    generated: { 'gemini-cli': { models: [], fetchedAt: 't', provenance: 'live' } },
    providerInfo: { 'gemini-cli': { suggestedModels: ['gemini-2.5-pro', 'gemini-2.5-flash'] } },
  });
  assert.deepEqual(r, { models: ['gemini-2.5-pro', 'gemini-2.5-flash'], source: 'builtin' });
});

test('resolveModelsForProvider: nothing anywhere -> empty list, still labeled builtin', () => {
  const r = resolveModelsForProvider('unknown-provider', {
    cache: createModelListCache(), generated: {}, providerInfo: {},
  });
  assert.deepEqual(r, { models: [], source: 'builtin' });
});

// ─── refreshModelCache ───────────────────────────────────────────────────────

test('refreshModelCache: one provider failing does not stop the cache from getting the other', async () => {
  const cache = createModelListCache();
  const providers = { a: {}, b: {} };
  const providerInfo = { a: { baseUrl: 'https://a.example/v1', custom: true }, b: { baseUrl: 'https://b.example/v1', custom: true } };
  const fetchImpl = async (url) => {
    if (/a\.example/.test(url)) return jsonResp({ data: [{ id: 'model-a' }] });
    throw new Error('unreachable');
  };
  await refreshModelCache({ cache, readConfig: () => ({}), providers, providerInfo, fetchImpl });
  assert.deepEqual(cache.get('a'), ['model-a']);
  assert.equal(cache.get('b'), undefined, 'the failing provider must simply be absent, never throw out of refreshModelCache');
});

test('refreshModelCache: a fast provider is cached promptly even while another hangs', async () => {
  const cache = createModelListCache();
  const providers = { a: {}, b: {} };
  const providerInfo = { a: { baseUrl: 'https://a.example/v1', custom: true }, b: { baseUrl: 'https://b.example/v1', custom: true } };
  const fetchImpl = (url) => {
    if (/a\.example/.test(url)) return Promise.resolve(jsonResp({ data: [{ id: 'model-a' }] }));
    return new Promise(() => {}); // never settles
  };
  const pending = refreshModelCache({ cache, readConfig: () => ({}), providers, providerInfo, fetchImpl });
  pending.catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(cache.get('a'), ['model-a'], 'must be cached without waiting for the hung provider');
  assert.equal(cache.get('b'), undefined);
});

test('refreshModelCache: readConfig throwing does not crash the refresh', async () => {
  const cache = createModelListCache();
  const providers = { a: {} };
  const providerInfo = { a: { baseUrl: 'https://a.example/v1', custom: true } };
  const fetchImpl = async () => jsonResp({ data: [{ id: 'model-a' }] });
  await assert.doesNotReject(() => refreshModelCache({
    cache, readConfig: () => { throw new Error('disk on fire'); }, providers, providerInfo, fetchImpl,
  }));
  assert.deepEqual(cache.get('a'), ['model-a']);
});

test('refreshModelCache: no cache supplied is a no-op, never throws', async () => {
  await assert.doesNotReject(() => refreshModelCache({}));
});

// ─── startModelRefreshLoop ───────────────────────────────────────────────────

test('startModelRefreshLoop: runs once after initialDelayMs, populating the cache', async () => {
  const cache = createModelListCache();
  const providers = { a: {} };
  const providerInfo = { a: { baseUrl: 'https://a.example/v1', custom: true } };
  const fetchImpl = async () => jsonResp({ data: [{ id: 'model-a' }] });
  const loop = startModelRefreshLoop({
    cache, readConfig: () => ({}), providers, providerInfo, fetchImpl,
    initialDelayMs: 5, intervalMs: 1_000_000,
  });
  try {
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(cache.get('a'), ['model-a']);
  } finally {
    loop.stop();
  }
});

test('startModelRefreshLoop: both timers are unref()d so they can never keep the process alive', () => {
  const createdTimeouts = [];
  const createdIntervals = [];
  const origSetTimeout = global.setTimeout;
  const origSetInterval = global.setInterval;
  global.setTimeout = (fn, ms) => { const t = origSetTimeout(fn, ms); createdTimeouts.push(t); return t; };
  global.setInterval = (fn, ms) => { const t = origSetInterval(fn, ms); createdIntervals.push(t); return t; };
  let loop;
  try {
    loop = startModelRefreshLoop({
      cache: createModelListCache(), providers: {}, providerInfo: {},
      initialDelayMs: 60_000, intervalMs: 60_000,
    });
  } finally {
    global.setTimeout = origSetTimeout;
    global.setInterval = origSetInterval;
  }
  assert.equal(createdTimeouts.length, 1);
  assert.equal(createdIntervals.length, 1);
  assert.equal(createdTimeouts[0].hasRef(), false, 'initial-delay timer must be unref()d');
  assert.equal(createdIntervals[0].hasRef(), false, 'interval timer must be unref()d');
  loop.stop();
});

test('startModelRefreshLoop: stop() prevents any further ticks', async () => {
  let calls = 0;
  const cache = createModelListCache();
  const providers = { a: {} };
  const providerInfo = { a: { baseUrl: 'https://a.example/v1', custom: true } };
  const fetchImpl = async () => { calls++; return jsonResp({ data: [{ id: 'm' }] }); };
  const loop = startModelRefreshLoop({
    cache, readConfig: () => ({}), providers, providerInfo, fetchImpl,
    initialDelayMs: 5, intervalMs: 10,
  });
  loop.stop();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls, 0, 'stop() before the initial delay elapses must suppress that tick too');
});
