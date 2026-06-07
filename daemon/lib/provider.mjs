// Provider resolution for the daemon: composes the base provider with
// opt-in cache / fallback / retry wrappers per request.

import { PROVIDERS } from '../../providers/registry.mjs';
import { withRateLimitRetry } from '../../providers/retry.mjs';
import { withFallback } from '../../providers/fallback.mjs';
import { withResponseCache } from '../../providers/cache.mjs';

// Resolve the provider for a request. Composes opt-in wrappers in this
// order (innermost first):
//   1. cache  — wraps the base provider so cache hits never trigger
//               fallback or retry (a hit is a successful response).
//   2. fallback — chain of alternates; pre-yield recoverable errors fall
//                 through; mid-stream errors bubble.
//   3. retry  — outermost so each retry covers the full chain (retry
//               exhausts → 429 to client).
// `cachedByName` is a per-handler Map shared across requests so the
// cache state actually persists between calls. Without that the cache
// would be empty on every request.
//
// Returns { provider } on success or { error } when the primary or any
// listed fallback name is unknown.
export function resolveProvider(body, providerName, cachedByName, logger) {
  if (!PROVIDERS[providerName]) return { error: `unknown provider: ${providerName}` };
  // The decorator callbacks emit one debug line each — useful for ops who
  // set --log debug to diagnose why a request is slow or which provider
  // actually served it. With the default level (info) these are silent.
  const dbg = (msg, fields) => { if (logger) logger.debug(msg, fields); };
  const wrapWithCache = (name) => {
    if (!cachedByName) return PROVIDERS[name];
    if (!cachedByName.has(name)) {
      cachedByName.set(name, withResponseCache(PROVIDERS[name], {
        maxEntries: cachedByName._opts?.maxEntries,
        ttlMs: cachedByName._opts?.ttlMs,
        onHit:  ({ keyHash, size }) => dbg('cache.hit',  { provider: name, keyHash: keyHash.slice(0, 12), size }),
        onMiss: ({ keyHash })       => dbg('cache.miss', { provider: name, keyHash: keyHash.slice(0, 12) }),
      }));
    }
    return cachedByName.get(name);
  };
  // Cache only when the request explicitly opts in. The handler-level
  // Map is shared so two requests with body.cache=true to the same base
  // provider hit the same cache.
  const useCache = !!body?.cache;
  let prov = useCache ? wrapWithCache(providerName) : PROVIDERS[providerName];
  if (Array.isArray(body?.fallback) && body.fallback.length > 0) {
    const chain = [prov];
    for (const name of body.fallback) {
      if (!PROVIDERS[name]) return { error: `unknown fallback provider: ${name}` };
      chain.push(useCache ? wrapWithCache(name) : PROVIDERS[name]);
    }
    prov = withFallback(chain, {
      onFallback: ({ from, to, err }) => dbg('provider.fallback', {
        from, to, errorCode: err?.code || null, errorMsg: String(err?.message || err).slice(0, 120),
      }),
    });
  }
  const r = body?.retry;
  if (r && Number.isFinite(r.attempts) && r.attempts > 0) {
    prov = withRateLimitRetry(prov, {
      attempts: r.attempts,
      maxBackoffMs: r.maxBackoffMs,
      onRetry: ({ attempt, retryAfterMs, err }) => dbg('provider.retry', {
        attempt, retryAfterMs, errorCode: err?.code || null,
      }),
    });
  }
  return { provider: prov };
}
