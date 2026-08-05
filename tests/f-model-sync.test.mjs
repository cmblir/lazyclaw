// tests/f-model-sync.test.mjs — providers/model_sync.mjs, the shared
// "fetch every live-capable provider, independently" helper behind both the
// daemon's background model-list cache (daemon/lib/model_cache.mjs) and
// scripts/sync-models.mjs (npm run models:sync).
//
// Pure + dependency-injected: every test supplies its own fake `providers` /
// `providerInfo` / `fetchImpl` so nothing here ever touches the network or
// the real provider registry.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  liveFetchableProviderIds,
  fetchAllLiveModels,
  mergeGeneratedModels,
} from '../providers/model_sync.mjs';

function jsonResp(obj) {
  return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
}

// Two fake OpenAI-compat-shaped providers (baseUrl alone is enough for
// supportsLiveFetch to say yes) plus a composite one that must be excluded.
const PROVIDERS = { a: {}, b: {}, orchestrator: {} };
const PROVIDER_INFO = {
  a: { baseUrl: 'https://a.example/v1', custom: true },
  b: { baseUrl: 'https://b.example/v1', custom: true },
  orchestrator: { composite: true },
};

test('liveFetchableProviderIds: only baseUrl-bearing providers, never the composite one', () => {
  assert.deepEqual(
    liveFetchableProviderIds({ providers: PROVIDERS, providerInfo: PROVIDER_INFO }).sort(),
    ['a', 'b'],
  );
});

test('fetchAllLiveModels: one provider throwing does not affect the other\'s result', async () => {
  const fetchImpl = async (url) => {
    if (/a\.example/.test(url)) return jsonResp({ data: [{ id: 'model-a1' }, { id: 'model-a2' }] });
    throw new Error('connection refused');
  };
  const results = await fetchAllLiveModels({ providers: PROVIDERS, providerInfo: PROVIDER_INFO, fetchImpl });
  const byId = Object.fromEntries(results.map((r) => [r.providerId, r]));
  assert.equal(byId.a.ok, true);
  assert.deepEqual(byId.a.models, ['model-a1', 'model-a2']);
  assert.equal(byId.b.ok, false);
  assert.match(byId.b.error, /connection refused/);
});

test('fetchAllLiveModels: onSettle fires per-provider as each one resolves, not gated behind a hung one', async () => {
  const seen = [];
  const fetchImpl = (url) => {
    if (/a\.example/.test(url)) return Promise.resolve(jsonResp({ data: [{ id: 'model-a1' }] }));
    // 'b' never settles — simulates an unreachable/hung provider. A bare
    // never-resolving Promise holds no timer/socket handle, so it can't
    // keep the test process (or this file) alive.
    return new Promise(() => {});
  };
  const pending = fetchAllLiveModels({
    providers: PROVIDERS, providerInfo: PROVIDER_INFO, fetchImpl,
    onSettle: (r) => seen.push(r.providerId),
  });
  pending.catch(() => {}); // never rejects either — deliberately left unresolved
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, ['a'], 'the fast provider must be reported before the hung one ever settles');
});

test('fetchAllLiveModels: an onSettle callback that throws does not break the batch', async () => {
  const fetchImpl = async () => jsonResp({ data: [{ id: 'x' }] });
  const results = await fetchAllLiveModels({
    providers: { a: {} }, providerInfo: { a: { baseUrl: 'https://a.example/v1', custom: true } }, fetchImpl,
    onSettle: () => { throw new Error('boom'); },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
});

// ─── mergeGeneratedModels ───────────────────────────────────────────────────

test('mergeGeneratedModels: no credential (ok:false) is skipped, previous entry kept untouched', () => {
  const previous = { codex: { models: ['gpt-old'], fetchedAt: '2020-01-01T00:00:00.000Z', provenance: 'live' } };
  const results = [{ providerId: 'codex', ok: false, error: 'no credential configured' }];
  const { next, report } = mergeGeneratedModels({ previous, results });
  assert.deepEqual(next.codex, previous.codex, 'previous entry must be byte-for-byte unchanged');
  assert.equal(report[0].action, 'skipped');
  assert.match(report[0].reason, /no credential/);
});

test('mergeGeneratedModels: a successful-but-empty fetch never overwrites a previously non-empty entry', () => {
  const previous = { claude: { models: ['claude-a', 'claude-b'], fetchedAt: 'x', provenance: 'live' } };
  const results = [{ providerId: 'claude', ok: true, models: [] }];
  const { next, report } = mergeGeneratedModels({ previous, results });
  assert.deepEqual(next.claude.models, ['claude-a', 'claude-b']);
  assert.equal(report[0].action, 'skipped');
  assert.match(report[0].reason, /empty/i);
});

test('mergeGeneratedModels: an empty fetch WITH NO previous entry is written (e.g. gemini-cli, decided server-side)', () => {
  const results = [{ providerId: 'gemini-cli', ok: true, models: [] }];
  const { next, report } = mergeGeneratedModels({ previous: {}, results, now: () => 'T0' });
  assert.deepEqual(next['gemini-cli'], { models: [], fetchedAt: 'T0', provenance: 'live' });
  assert.equal(report[0].action, 'synced');
  assert.equal(report[0].count, 0);
});

test('mergeGeneratedModels: a non-empty fetch replaces the previous entry with fresh provenance + timestamp', () => {
  const previous = { codex: { models: ['gpt-old'], fetchedAt: 'stale', provenance: 'live' } };
  const results = [{ providerId: 'codex', ok: true, models: ['gpt-new-1', 'gpt-new-2'] }];
  const { next, report } = mergeGeneratedModels({ previous, results, now: () => 'T1' });
  assert.deepEqual(next.codex, { models: ['gpt-new-1', 'gpt-new-2'], fetchedAt: 'T1', provenance: 'live' });
  assert.equal(report[0].action, 'synced');
  assert.equal(report[0].count, 2);
});

test('mergeGeneratedModels: never invents an id — every model in `next` traces to `previous` or `results`', () => {
  const previous = { kept: { models: ['kept-1'], fetchedAt: 'a', provenance: 'live' } };
  const results = [
    { providerId: 'kept', ok: false, error: 'no credential' },
    { providerId: 'fresh', ok: true, models: ['fresh-1', 'fresh-2'] },
  ];
  const { next } = mergeGeneratedModels({ previous, results, now: () => 'T2' });
  const allowedIds = new Set(['kept-1', 'fresh-1', 'fresh-2']);
  for (const entry of Object.values(next)) {
    for (const id of entry.models) assert.ok(allowedIds.has(id), `unexpected invented id: ${id}`);
  }
  assert.deepEqual(next.kept.models, ['kept-1']);
  assert.deepEqual(next.fresh.models, ['fresh-1', 'fresh-2']);
});
