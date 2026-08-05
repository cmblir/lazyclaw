// providers/model_sync.mjs — shared "fetch every live-capable provider,
// independently" helper. Used by two callers that must stay in lockstep:
//   - daemon/lib/model_cache.mjs   (background refresh of the in-daemon
//                                   live cache GET /providers reads from)
//   - scripts/sync-models.mjs      (npm run models:sync — regenerates the
//                                   committed providers/models.generated.mjs)
//
// Pure and dependency-injectable — no timers, no fs, no process-level state —
// so both callers (and their tests) share one seam instead of duplicating the
// per-provider credential plumbing that already lives in
// providers/model_catalogue.mjs.

import { PROVIDERS, PROVIDER_INFO } from './registry.mjs';
import { supportsLiveFetch, fetchModelsForProvider } from './model_catalogue.mjs';
import { _resolveAuthKey } from '../lib/config.mjs';

/**
 * Provider ids worth attempting a live fetch for — everything
 * `supportsLiveFetch` accepts (openai/ollama/anthropic/gemini, the keyless
 * CLI trio, any builtin OpenAI-compat vendor, any custom baseUrl entry).
 * @param {{providers?: object, providerInfo?: object}} [opts]
 * @returns {string[]}
 */
export function liveFetchableProviderIds({ providers = PROVIDERS, providerInfo = PROVIDER_INFO } = {}) {
  return Object.keys(providers).filter((id) => supportsLiveFetch(providerInfo[id], id));
}

/**
 * Fetch every live-fetchable provider's model list. Each provider is
 * isolated in its own try/catch inside `Promise.all` — one throwing (no
 * credential, network error, timeout, HTTP error) never stops or delays the
 * others. Returns `{providerId, ok:true, models}` or
 * `{providerId, ok:false, error}` per provider; callers decide what to do
 * with a failure (daemon: leave the cache entry as-is; sync script: skip and
 * keep the previous generated entry).
 *
 * `onSettle`, when supplied, fires the instant EACH provider's own fetch
 * settles — before `Promise.all` waits for the rest. This is what lets a
 * caller apply a fast provider's result immediately instead of gating it
 * behind a slow or hung one: the daemon's background refresh
 * (daemon/lib/model_cache.mjs) uses it to write into the live cache
 * per-provider, so one unreachable/hanging provider only ever delays its
 * OWN cache entry, never the others'.
 *
 * @param {object} deps
 * @param {object} [deps.cfg]            on-disk config, passed through to fetchModelsForProvider
 * @param {object} [deps.providers]      defaults to the live PROVIDERS registry
 * @param {object} [deps.providerInfo]   defaults to the live PROVIDER_INFO registry
 * @param {(id:string)=>string} [deps.resolveAuthKey]  defaults to lib/config.mjs's _resolveAuthKey(cfg, id)
 * @param {typeof fetch} [deps.fetchImpl]  test seam — never hits the network when supplied
 * @param {object} [deps.credReaders]    test seam — spread into each fetchModelsForProvider call
 *   (_credReader / _codexCachedModels / _codexConfigModels / _geminiConfigModels)
 * @param {(r:{providerId:string, ok:boolean, models?:string[], error?:string}) => void} [deps.onSettle]
 * @returns {Promise<Array<{providerId:string, ok:boolean, models?:string[], error?:string}>>}
 */
export async function fetchAllLiveModels({
  cfg = {},
  providers = PROVIDERS,
  providerInfo = PROVIDER_INFO,
  resolveAuthKey,
  fetchImpl,
  credReaders = {},
  onSettle,
} = {}) {
  const ids = liveFetchableProviderIds({ providers, providerInfo });
  const authResolver = resolveAuthKey || ((id) => _resolveAuthKey(cfg, id));
  return Promise.all(ids.map(async (providerId) => {
    let result;
    try {
      const models = await fetchModelsForProvider({
        providerId,
        cfg,
        registryMod: { PROVIDER_INFO: providerInfo },
        resolveAuthKey: authResolver,
        fetchImpl,
        ...credReaders,
      });
      result = { providerId, ok: true, models: Array.isArray(models) ? models : [] };
    } catch (err) {
      result = { providerId, ok: false, error: err?.message || String(err) };
    }
    if (typeof onSettle === 'function') {
      try { onSettle(result); } catch { /* a caller's callback throwing must not fail the fetch */ }
    }
    return result;
  }));
}

/**
 * Merge a batch of `fetchAllLiveModels` results into the generated-file
 * shape, honoring the three hard rules from the live-model-lists brief:
 *   - a provider with no credential (ok:false) is SKIPPED — its previous
 *     entry is kept byte-for-byte;
 *   - a provider whose live fetch succeeded but came back empty, when a
 *     previous NON-empty entry exists, is also skipped (never overwrite a
 *     good list with an empty one) — an empty result with no prior entry
 *     IS written, because that can be the honest answer (e.g. gemini-cli,
 *     whose model set is decided server-side);
 *   - every written entry carries its own provenance + fetchedAt timestamp
 *     so staleness is visible in the file itself.
 * No model id is ever invented here — every id in `next` came from either
 * `results` (the network, this run) or `previous` (the network, a prior run).
 *
 * @param {object} opts
 * @param {Record<string, {models:string[], fetchedAt:string, provenance:string}>} [opts.previous]
 * @param {Array<{providerId:string, ok:boolean, models?:string[], error?:string}>} opts.results
 * @param {() => string} [opts.now]  injectable clock for tests
 * @returns {{next: object, report: Array<{providerId:string, action:'synced'|'skipped', count?:number, reason?:string}>}}
 */
export function mergeGeneratedModels({ previous = {}, results = [], now = () => new Date().toISOString() } = {}) {
  const next = { ...previous };
  const report = [];
  for (const r of results) {
    const prev = previous[r.providerId];
    if (!r.ok) {
      report.push({ providerId: r.providerId, action: 'skipped', reason: r.error });
      continue;
    }
    const prevCount = prev && Array.isArray(prev.models) ? prev.models.length : 0;
    if (r.models.length === 0 && prevCount > 0) {
      report.push({
        providerId: r.providerId,
        action: 'skipped',
        reason: `live fetch returned an empty list — keeping ${prevCount} previous model(s)`,
      });
      continue;
    }
    next[r.providerId] = { models: r.models.slice(), fetchedAt: now(), provenance: 'live' };
    report.push({ providerId: r.providerId, action: 'synced', count: r.models.length });
  }
  return { next, report };
}
