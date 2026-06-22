// Local-only HTTP daemon for LazyClaw — the OpenClaw "gateway" shape,
// scoped down to what this CLI actually offers.
//
// Always binds 127.0.0.1 (loopback). The endpoints are read-only inspection
// (version / providers / sessions) and `agent` for one-shot inference. The
// daemon never writes to disk under its own authority — only `agent` with
// an explicit `sessionId` ends up appending a turn to that session, which
// is the exact same operation the CLI does.
//
// Streaming: POST /agent with `{stream: true}` returns SSE
// (`data: <json>\n\n` per token, `event: done` to terminate). Without it,
// the response is a single JSON object once the full reply has arrived.

import http from 'node:http';

import { ChallengeRegistry } from './gateway/device_auth.mjs';
import { createGateway } from './gateway/http_gateway.mjs';
import { TokenBucketLimiter } from './ratelimit.mjs';
import { createLogger } from './logger.mjs';
import * as nudge from './mas/nudge.mjs';
// MCP: cfg.mcp.servers[] are spawned once per daemon process at boot and
// stopped on graceful shutdown. Booted here (the single per-process seam,
// after config is available) — the unattended-safety guard runs earlier in
// commands/daemon.mjs before startDaemon, so this only spawns once exposure
// has been cleared. Best-effort: a failing server is logged, never fatal.
import * as mcpSpawn from './mcp/server_spawn.mjs';

// Route bodies moved to daemon/routes/*; makeHandler now only needs the
// response/auth helpers used by the pre-switch middleware + dispatch.
import { readTextBody, writeJson, statusForProviderError } from './daemon/lib/respond.mjs';
import { isAuthorized, isOriginAllowed } from './daemon/lib/auth.mjs';
import { ROUTES } from './daemon/route_table.mjs';

// Re-exported so existing importers (cli.mjs, tests) keep their path.
export { statusForProviderError };

/**
 * @param {{
 *   readConfig: () => Record<string, unknown>,
 *   writeConfig?: (cfg: Record<string, unknown>) => void,
 *   sessionsDirGetter: () => string,
 *   sessionsMod: typeof import('./sessions.mjs'),
 *   version: () => string,
 *   workflowStateDir?: () => string,
 *   authToken?: string,
 *   allowedOrigins?: string[],
 *   rateLimit?: { capacity?: number, refillPerSec?: number } | null,
 *   responseCache?: { maxEntries?: number, ttlMs?: number } | true | null,
 *   logger?: ReturnType<typeof createLogger> | null,
 *   costCap?: Record<string, number> | null,
 * }} ctx
 *
 * `writeConfig` is optional; when omitted the mutation endpoints (POST
 * /providers, DELETE /providers/<name>, PUT/DELETE /rates/<key>, PUT
 * /config/<key>) reject with 405 Method Not Allowed. The CLI's
 * `cmdDashboard` always supplies it; bare `lazyclaw daemon --once` callers
 * can opt out by leaving it undefined.
 */
export function makeHandler(ctx) {
  const authToken = ctx.authToken || null;
  const allowedOrigins = Array.isArray(ctx.allowedOrigins) ? ctx.allowedOrigins : [];
  // dashboard subcommand opts in so the browser tab it just opened can
  // actually call its own daemon. Bare `lazyclaw daemon` leaves this off
  // and the explicit allowlist (or no-browser default) stays in force.
  const allowLoopback = !!ctx.allowLoopbackOrigin;
  // Default state dir matches the CLI's default. Callers can override
  // via ctx.workflowStateDir or LAZYCLAW_WORKFLOW_STATE_DIR env var.
  const workflowStateDir = ctx.workflowStateDir
    || (() => process.env.LAZYCLAW_WORKFLOW_STATE_DIR || '.workflow-state');
  ctx = { ...ctx, workflowStateDir };
  // Rate limiter is opt-in; passing nothing → unlimited (the historical
  // single-user-loopback default). When enabled, scope is per remote IP.
  const limiter = ctx.rateLimit
    ? new TokenBucketLimiter({
        capacity: ctx.rateLimit.capacity,
        refillPerSec: ctx.rateLimit.refillPerSec,
      })
    : null;
  // Cost cap: ctx.costCap = { USD: 1.50, EUR: 0.80, ... }. When the
  // cumulative cost in any listed currency reaches its cap, /chat and
  // /agent reject with 402 Payment Required. Other routes (/version,
  // /metrics, etc.) stay reachable so monitoring still works after the
  // cap fires. Empty/missing → unlimited (the historical default).
  const costCap = ctx.costCap && typeof ctx.costCap === 'object' ? ctx.costCap : null;
  // Per-handler cache map — populated lazily as requests opt in via
  // body.cache. Shared across requests so the second identical call
  // actually hits. We attach the configured opts so the lazy init
  // gets the right TTL/maxEntries.
  const cachedByName = ctx.responseCache ? Object.assign(new Map(), { _opts: ctx.responseCache === true ? {} : ctx.responseCache }) : null;
  // Logger is opt-in via ctx.logger (the CLI passes one when --log <level>
  // is set). Falsy → silent (the historical default; tests stay quiet).
  const logger = ctx.logger || null;
  // Per-handler metrics. The /metrics endpoint reads these. Bumped on
  // res.close so middleware short-circuits (403/401/429) get counted.
  const metrics = {
    startedAtMs: Date.now(),
    requestsTotal: 0,
    requestsByStatus: /** @type {Record<string, number>} */({}),
    rateLimitDenied: 0,
    // Cumulative cost across all requests that produced a `cost` block.
    // Keyed by currency so a heterogeneous fleet (USD-priced anthropic,
    // EUR-priced regional contract) doesn't silently sum mismatched
    // numbers. Tokens are unit-free so we keep them in a single counter.
    costsByCurrency: /** @type {Record<string, number>} */({}),
    tokensTotal: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  };
  // Device gateway (Phase 27). The ChallengeRegistry is a per-process
  // singleton: a challenge minted by one request is consumed by a later
  // one, so it must outlive a single call.
  const gwConfigDir = typeof ctx.sessionsDirGetter === 'function' ? ctx.sessionsDirGetter() : undefined;
  const gateway = createGateway({ configDir: gwConfigDir, challengeRegistry: new ChallengeRegistry(), heartbeatMs: 25000 });
  // Phase B nudge loop — scans recent.jsonl every 5 min and pushes
  // nudge.suggest_skill onto the SSE bus so the curator can prompt.
  // v5 dashboard polls GET /skills/suggestions; we also keep a small
  // ring buffer here so the UI can fetch the most recent N without
  // having to subscribe to the SSE bus.
  const SUGG_RING_MAX = 50;
  const nudgeSuggestionsRing = [];
  // v5 Group A (M2): when the operator opts in via
  // cfg.orchestra.learning.autoSynthOnNudge, every emitted cluster
  // also triggers runLearning('nudge', { cluster }) so the canonical
  // funnel can distill the repeated prompt into a SKILL.md. The SSE
  // broadcast and ring buffer still fire unconditionally so the
  // dashboard sees suggestions even when auto-synth is disabled
  // (the conservative default — we never want a noisy chat to bloat
  // the skills/ dir without the operator's blessing).
  let _learningHub = null;
  const _readAutoSynthOnNudge = () => {
    try {
      const cfg = typeof ctx.readConfig === 'function' ? ctx.readConfig() : {};
      const orch = cfg?.orchestra || cfg?.orchestrator || {};
      return !!(orch.learning && orch.learning.autoSynthOnNudge);
    } catch { return false; }
  };
  const _nudgeLoop = nudge.startNudgeLoop({
    configDir: gwConfigDir,
    emit: (event) => {
      try { gateway.broadcast?.('nudge.suggest_skill', event); }
      catch (err) { logger?.warn?.('nudge_emit_failed', { err: err.message }); }
      try {
        nudgeSuggestionsRing.unshift(event);
        if (nudgeSuggestionsRing.length > SUGG_RING_MAX) {
          nudgeSuggestionsRing.length = SUGG_RING_MAX;
        }
      } catch { /* ignore */ }
      if (_readAutoSynthOnNudge()) {
        (async () => {
          try {
            if (!_learningHub) _learningHub = await import('./mas/learning.mjs');
            const cfg = typeof ctx.readConfig === 'function' ? ctx.readConfig() : {};
            // Wrap the single cluster in the items[] shape runLearning('nudge')
            // expects so the representative task is the cluster's sample
            // prompt.
            const itemTask = { id: `nudge-${event.ts || Date.now()}`, title: 'nudge cluster', turns: [{ agent: 'user', text: event.cluster?.sample || '' }] };
            await _learningHub.runLearning('nudge', {
              cluster: { items: [itemTask] },
              configDir: gwConfigDir,
              cfg,
            });
          } catch (err) {
            try { logger?.warn?.('nudge_learning_failed', { err: err.message }); }
            catch { /* ignore */ }
          }
        })();
      }
    },
    logger,
  });
  // Boot any configured MCP servers (cfg.mcp.servers[]). Each registers its
  // tools as mcp:<server>:<tool> (sensitive=true → approval gate). Fire-and-
  // forget: startConfigured catches per-server, and we swallow the outer
  // promise so a slow/failing spawn never blocks or crashes the daemon.
  (async () => {
    try {
      const cfg = typeof ctx.readConfig === 'function' ? ctx.readConfig() : {};
      const results = await mcpSpawn.startConfigured(cfg);
      for (const r of results) {
        if (r?.ok) logger?.info?.('mcp.server_started', { name: r.name, tools: r.tools?.length ?? 0 });
        else logger?.warn?.('mcp.server_failed', { name: r?.name, err: r?.error });
      }
    } catch (err) {
      logger?.warn?.('mcp.boot_failed', { err: err?.message });
    }
  })();
  // Stop MCP servers on graceful shutdown (unregisters their tools too).
  const _stopMcp = () => { mcpSpawn.stopAll().catch(() => { /* best-effort */ }); };
  process.on('SIGTERM', () => { _nudgeLoop.stop(); _stopMcp(); });
  process.on('SIGINT', () => { _nudgeLoop.stop(); _stopMcp(); });
  return async function handler(req, res) {
    // Capture method+path before any handler logic runs; req.url survives
    // the response but capturing now keeps the log line stable even if a
    // future refactor mutates req.
    const startedAt = Date.now();
    const method = req.method;
    const path = (req.url || '/').split('?')[0];
    const remote = req.socket?.remoteAddress || 'no-socket';
    // Hook res.writeHead to capture the eventual status without
    // intercepting the response body. We log on res 'close'.
    let observedStatus = 0;
    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = (status, ...rest) => {
      observedStatus = status;
      return origWriteHead(status, ...rest);
    };
    // Attach the close-handler only when res supports it. Unit tests
    // sometimes drive the handler with a stub `res` that has writeHead +
    // end but no event-emitter surface; those exercises don't care about
    // metrics or access logs and should not crash.
    if (typeof res.once === 'function') {
      res.once('close', () => {
        // Counters fire even without a logger so /metrics is meaningful
        // by default. Status 0 means writeHead never ran (e.g. body parse
        // crashed) — bucket those as "0" so we don't lose the request.
        metrics.requestsTotal += 1;
        const sk = String(observedStatus || 0);
        metrics.requestsByStatus[sk] = (metrics.requestsByStatus[sk] || 0) + 1;
        if (logger) {
          const durationMs = Date.now() - startedAt;
          logger.info('access', { method, path, status: observedStatus, durationMs, remote });
        }
      });
    }
    try {
      // Origin gate runs *before* auth so a browser-originated request
      // can't even probe whether a token is required.
      if (!isOriginAllowed(req, allowedOrigins, allowLoopback)) {
        return writeJson(res, 403, { error: 'forbidden origin' });
      }
      // Device gateway (Phase 27) — routed BEFORE the shared auth-token
      // gate. Companion-node auth is the gateway's own Ed25519 device-auth
      // (challenge/sign/approve + bearer token); the only unauthenticated
      // route, /gateway/connect/challenge, returns nothing but a random
      // nonce. The bypass decision uses the NORMALIZED pathname (the same
      // one the gateway routes on) so a dot-segment path like
      // `/gateway/../sessions` can't skip the auth-token gate — it
      // normalizes to `/sessions`, fails this prefix test, and falls
      // through to the protected handler. When the limiter is enabled,
      // gateway traffic uses its own key namespace so an unauthenticated
      // flood can't drain the authenticated user's per-IP budget.
      let gwPath = '';
      try { gwPath = new URL(req.url || '/', 'http://localhost').pathname; } catch { gwPath = ''; }
      if (gwPath.startsWith('/gateway/')) {
        if (limiter) {
          const key = 'gw:' + (req.socket?.remoteAddress || 'no-socket');
          const verdict = limiter.consume(key);
          if (!verdict.allowed) {
            metrics.rateLimitDenied += 1;
            const retrySeconds = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
            return writeJson(res, 429, { error: 'rate limit exceeded', retryAfterMs: verdict.retryAfterMs }, { 'retry-after': String(retrySeconds) });
          }
        }
        return await gateway.handle(req, res, { readBody: readTextBody });
      }
      // Authentication gate — when authToken is set, every request must
      // present `Authorization: Bearer <token>`. This is opt-in because
      // the default deployment is loopback-only single-user; the token
      // is for shared-host scenarios or when you want to expose the
      // daemon over an SSH tunnel and lock down the open port.
      if (authToken && !isAuthorized(req, authToken)) {
        return writeJson(res, 401, { error: 'unauthorized' }, {
          'www-authenticate': 'Bearer realm="lazyclaw"',
        });
      }
      // Rate limit gate — *after* auth so the budget is per authenticated
      // identity rather than per IP-pretending-to-be-someone-else. Authed
      // means the remote actually proved they have the shared secret.
      if (limiter) {
        // The remote-IP key falls back to a fixed string for tests that
        // drive the handler directly without a socket. socket.remoteAddress
        // is "127.0.0.1" for loopback; that's fine for our scope.
        const key = req.socket?.remoteAddress || 'no-socket';
        const verdict = limiter.consume(key);
        if (!verdict.allowed) {
          metrics.rateLimitDenied += 1;
          const retrySeconds = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
          return writeJson(res, 429, {
            error: 'rate limit exceeded',
            retryAfterMs: verdict.retryAfterMs,
          }, { 'retry-after': String(retrySeconds) });
        }
      }
      const url = new URL(req.url || '/', 'http://localhost');
      const route = `${req.method} ${url.pathname}`;
      const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
      const providerMatch = url.pathname.match(/^\/providers\/([^/]+)$/);
      const providerTestMatch = url.pathname.match(/^\/providers\/([^/]+)\/test$/);
      const sessionExportMatch = url.pathname.match(/^\/sessions\/([^/]+)\/export$/);
      const skillMatch = url.pathname.match(/^\/skills\/([^/]+)$/);
      const workflowMatch = url.pathname.match(/^\/workflows\/([^/]+)$/);
      const configKeyMatch = url.pathname.match(/^\/config\/([^/]+)$/);
      const ratesKeyMatch = url.pathname.match(/^\/rates\/([^/]+)$/);
      // Per-request dispatch context. Carries the handler-scoped state
      // (ctx/logger/metrics/gateway/...) plus the per-request locals and
      // pre-computed path-param matches so each route module can run with
      // its original closure variables intact.
      const c = {
        ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir,
        nudgeSuggestionsRing, workflowStateDir,
        req, res, method, path, route, url,
        sessionMatch, providerMatch, providerTestMatch, sessionExportMatch,
        skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch,
      };
      // First-match dispatch — ROUTES order mirrors the old switch.
      for (const r of ROUTES) {
        if (r.m(c)) return await r.h(c);
      }
      return writeJson(res, 404, { error: 'not found', route });
    } catch (err) {
      return writeJson(res, 500, { error: err?.message || String(err) });
    }
  };
}

/**
 * Graceful shutdown with a hard timeout. Calls `server.close()` so the
 * server stops accepting new connections and waits for in-flight to
 * drain — but races against `timeoutMs` so a hung stream can't keep
 * the process alive forever. After timeout we force-close every open
 * connection (Node ≥18.2) and resolve.
 *
 * Returns `{ forced: boolean }`:
 *   forced=false → graceful drain completed in time
 *   forced=true  → timeout fired; connections were force-closed
 *
 * Exported for unit testing without spawning a real daemon.
 *
 * @param {{ close: (cb: (err?: Error) => void) => void, closeAllConnections?: () => void }} server
 * @param {number} timeoutMs
 */
export function gracefulShutdown(server, timeoutMs) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (forced) => {
      if (resolved) return;
      resolved = true;
      resolve({ forced });
    };
    const timer = setTimeout(() => {
      if (typeof server.closeAllConnections === 'function') {
        try { server.closeAllConnections(); } catch { /* swallow */ }
      }
      finish(true);
    }, timeoutMs);
    timer.unref?.();
    server.close((err) => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/**
 * Start the daemon. Always binds 127.0.0.1.
 * @param {{
 *   port?: number,
 *   once?: boolean,
 *   readConfig: () => Record<string, unknown>,
 *   sessionsDirGetter: () => string,
 *   sessionsMod: typeof import('./sessions.mjs'),
 *   version: () => string,
 *   authToken?: string,
 *   allowedOrigins?: string[],
 *   rateLimit?: { capacity?: number, refillPerSec?: number } | null,
 *   responseCache?: { maxEntries?: number, ttlMs?: number } | true | null,
 *   logger?: ReturnType<typeof createLogger> | null,
 *   costCap?: Record<string, number> | null,
 * }} opts
 * @returns {Promise<{ port: number, server: http.Server, close: () => Promise<void> }>}
 */
export async function startDaemon(opts) {
  const handler = makeHandler(opts);
  const server = http.createServer(async (req, res) => {
    await handler(req, res);
    if (opts.once) {
      // Allow the response to flush before closing.
      setImmediate(() => server.close());
    }
  });
  return new Promise((resolve, reject) => {
    // EADDRINUSE (and other listen-time errors) used to crash the
    // process — listen() emits 'error' before the success callback
    // fires, and we never wired that channel. Capture it once so
    // callers (cmdDashboard / cmdDaemon) can choose to kill the
    // occupant or fall back to a random port.
    const onError = (err) => {
      server.off('error', onError);
      reject(err);
    };
    server.once('error', onError);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      server.off('error', onError);
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        server,
        close: () => new Promise(r => server.close(() => r())),
      });
    });
  });
}
