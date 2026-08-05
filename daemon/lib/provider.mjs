// Provider resolution for the daemon: composes the base provider with
// opt-in cache / fallback / retry wrappers per request.

import { PROVIDERS } from '../../providers/registry.mjs';
import { withRateLimitRetry } from '../../providers/retry.mjs';
import { withFallback } from '../../providers/fallback.mjs';
import { withResponseCache } from '../../providers/cache.mjs';
import { emit as emitEvent } from '../../mas/events.mjs';

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
/**
 * The `detail` a provider.error event may carry — a routing fact, never text.
 *
 * Deliberately does NOT consider err.message. Every connected dashboard receives
 * this over SSE, and providers/anthropic.mjs's ApiError builds its message as
 * `anthropic api ${status}: ${body.slice(0, 200)}` — 200 characters of the
 * provider's raw HTTP error body. ApiError also sets no `code`, so a message
 * fallback would be the NORMAL path for an Anthropic failure rather than a rare
 * one. code / status / name are non-content, which is all the live rail needs:
 * "anthropic failed, 429". Exported so the rule is unit-tested rather than
 * trusted inside a callback.
 * @param {unknown} err
 * @returns {string}
 */
export function _detailForFallback(err) {
  return String(err?.code || err?.status || err?.name || 'failed').slice(0, 40);
}

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
      onFallback: ({ from, to, err }) => {
        dbg('provider.fallback', {
          from, to, errorCode: err?.code || null, errorMsg: String(err?.message || err).slice(0, 120),
        });
        // Live-rail routing fact: which provider failed, never the error text.
        // See _detailForFallback's docstring for why err.message is excluded.
        emitEvent('provider.error', { provider: from, detail: _detailForFallback(err) });
      },
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
