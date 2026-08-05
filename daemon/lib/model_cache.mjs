// daemon/lib/model_cache.mjs — the live model-list cache GET /providers
// reads from, plus the background refresh loop that populates it.
//
// GET /providers is called on every dashboard load and must never block on
// a provider's network — a slow, rate-limited, or hung endpoint would hang
// the whole route. So the route never fetches; it only reads this
// in-memory cache, which is refreshed off the request path (see
// startModelRefreshLoop below) and falls back to the generated file, then
// the static registry, when nothing fresh is cached.
//
// Resolution order per provider: live cache (fresh) -> providers/
// models.generated.mjs (last `npm run models:sync`) -> PROVIDER_INFO's
// hand-written suggestedModels. Each tier is only used when the one above
// it has nothing — see resolveModelsForProvider.

import { PROVIDER_INFO } from '../../providers/registry.mjs';
import { GENERATED_MODELS } from '../../providers/models.generated.mjs';
import { fetchAllLiveModels } from '../../providers/model_sync.mjs';

// Model catalogues change on the order of weeks (a new Claude/GPT/Gemini
// model ships, at most, every few weeks) — there is no benefit to polling
// faster than that, and doing so would just hammer providers (and their
// rate limits) for data that hasn't moved. A 60-minute TTL keeps the
// dashboard within an hour of the live truth; refreshing at HALF the TTL
// (30 minutes) means one missed/failed tick doesn't immediately let an
// entry go stale — the next tick, 30 minutes later, still lands inside the
// window. Both are comfortably "tens of minutes upward," per the brief.
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
// "Shortly after boot" — long enough that the daemon's own startup (MCP
// server spawn, gateway init) isn't competing with a burst of provider
// fetches, short enough that the first dashboard load a user makes a few
// seconds in is likely already served from a warm cache.
const DEFAULT_INITIAL_DELAY_MS = 15 * 1000;

/**
 * A tiny TTL map: providerId -> string[] models, fetched at most `ttlMs` ago.
 * `get` returns `undefined` for a missing OR expired entry (and evicts the
 * latter) so callers can tell "never fetched / gone stale" apart from "fetched,
 * and the honest answer was an empty list" (e.g. gemini-cli, whose model set
 * is decided server-side — see providers/model_catalogue.mjs).
 */
export function createModelListCache({ ttlMs = DEFAULT_TTL_MS } = {}) {
  const store = new Map();
  return {
    set(providerId, models) {
      store.set(providerId, { models: Array.isArray(models) ? models.slice() : [], fetchedAt: Date.now() });
    },
    get(providerId) {
      const entry = store.get(providerId);
      if (!entry) return undefined;
      if (Date.now() - entry.fetchedAt > ttlMs) { store.delete(providerId); return undefined; }
      return entry.models;
    },
    size() { return store.size; },
  };
}

/**
 * Resolve `{models, source}` for one provider following the live -> generated
 * -> static order. `source` is the field GET /providers exposes as
 * `modelsSource` so the dashboard can tell a fetched list from a frozen one:
 *   'live'    — served from the in-memory cache (fetched this daemon run)
 *   'builtin' — served from the generated file or the hand-written registry
 * A live cache hit is trusted even when empty (that IS the live answer for
 * gemini-cli); the generated file is only used when it has entries, since an
 * empty generated record is less useful than the curated suggestedModels
 * fallback.
 *
 * @param {string} providerId
 * @param {{cache?: ReturnType<typeof createModelListCache>, generated?: object, providerInfo?: object}} [opts]
 * @returns {{models: string[], source: 'live'|'builtin'}}
 */
export function resolveModelsForProvider(providerId, { cache, generated = GENERATED_MODELS, providerInfo = PROVIDER_INFO } = {}) {
  const live = cache?.get(providerId);
  if (live !== undefined) return { models: live, source: 'live' };
  const gen = generated?.[providerId];
  if (gen && Array.isArray(gen.models) && gen.models.length > 0) {
    return { models: gen.models, source: 'builtin' };
  }
  const meta = providerInfo?.[providerId] || {};
  const suggested = Array.isArray(meta.suggestedModels) ? meta.suggestedModels : [];
  return { models: suggested, source: 'builtin' };
}

/**
 * One refresh pass: fetch every live-fetchable provider (independently — see
 * fetchAllLiveModels) and populate `cache` with whatever succeeded. Each
 * provider's result is applied to the cache via `onSettle` the instant THAT
 * provider's own fetch resolves, not after `Promise.all` finishes waiting
 * for every provider — so a single slow/hung/unreachable provider only ever
 * delays its own cache entry, never the others'. Failures are logged at
 * debug level and otherwise ignored; the cache simply keeps (or never gets)
 * that provider's entry, so resolveModelsForProvider falls through to the
 * generated/static tiers for it.
 *
 * @returns {Promise<Array<{providerId:string, ok:boolean, models?:string[], error?:string}>>}
 */
export async function refreshModelCache({ cache, readConfig, logger, fetchImpl, providers, providerInfo } = {}) {
  if (!cache) return [];
  let cfg = {};
  try { cfg = (typeof readConfig === 'function' ? readConfig() : {}) || {}; } catch { /* best-effort */ }
  return fetchAllLiveModels({
    cfg, providers, providerInfo, fetchImpl,
    onSettle: (r) => {
      if (r.ok) cache.set(r.providerId, r.models);
      else logger?.debug?.('models.refresh_failed', { provider: r.providerId, error: r.error });
    },
  });
}

/**
 * Start the background refresh: once after `initialDelayMs`, then every
 * `intervalMs`. Both timers are `unref()`d so a bare `lazyclaw --version` or
 * the test suite never waits on them to exit — they only run for as long as
 * the process is alive for other reasons.
 *
 * @returns {{stop: () => void}}
 */
export function startModelRefreshLoop({
  cache, readConfig, logger, fetchImpl, providers, providerInfo,
  intervalMs = DEFAULT_INTERVAL_MS, initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
} = {}) {
  let stopped = false;
  const run = () => {
    if (stopped) return;
    refreshModelCache({ cache, readConfig, logger, fetchImpl, providers, providerInfo })
      .catch((err) => { try { logger?.debug?.('models.refresh_error', { error: err?.message }); } catch { /* ignore */ } });
  };
  const initialTimer = setTimeout(run, initialDelayMs);
  initialTimer.unref?.();
  const intervalTimer = setInterval(run, intervalMs);
  intervalTimer.unref?.();
  return {
    stop() {
      stopped = true;
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    },
  };
}
