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
import nodePath from 'node:path';
import fs from 'node:fs';

import { PROVIDERS, PROVIDER_INFO, maskApiKey } from './providers/registry.mjs';
import { withRateLimitRetry } from './providers/retry.mjs';
import { withFallback } from './providers/fallback.mjs';
import { withResponseCache } from './providers/cache.mjs';
import { costFromUsage, RATE_CARD_SHAPE } from './providers/rates.mjs';
import { composeSystemPrompt, listSkills, loadSkill, skillPath, installSkill, removeSkill, parseFrontmatter, defaultConfigDir as skillsDefaultConfigDir } from './skills.mjs';
import * as indexDb from './mas/index_db.mjs';
import * as skillSynth from './mas/skill_synth.mjs';
import { listBackends as sandboxListBackends } from './sandbox/index.mjs';
import { ChallengeRegistry } from './gateway/device_auth.mjs';
import { createGateway } from './gateway/http_gateway.mjs';
import { TokenBucketLimiter } from './ratelimit.mjs';
import { createLogger } from './logger.mjs';
import { summarizeState, listSessions as listWorkflowSessions, loadStateFile as loadWorkflowState, aggregateNodeStats } from './workflow/summary.mjs';
import { validateConfig } from './config-validate.mjs';
import { validateRates } from './rates-validate.mjs';
import * as nudge from './mas/nudge.mjs';

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
function resolveProvider(body, providerName, cachedByName, logger) {
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

async function fileExists(p) {
  try { await fs.promises.access(p); return true; }
  catch { return false; }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', d => { buf += d; if (buf.length > 5 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); }
      catch (e) { reject(new Error(`invalid JSON body: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

// Raw body reader — used for `PUT /skills/<name>` where the body is
// markdown rather than JSON. Same 1 MiB cap as the CLI's `--from-url`
// path so HTTP can't sneak past the safeguard the CLI enforces.
const SKILL_MAX_BYTES = 1_048_576;
function readTextBody(req, maxBytes = SKILL_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', d => {
      buf += d;
      if (buf.length > maxBytes) {
        reject(new Error(`body exceeds ${maxBytes} bytes`));
        req.destroy();
      }
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

function writeJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

// Has the cumulative cost in any capped currency reached the cap?
// Returns the offending currency + amount + cap so the caller can
// surface it cleanly, or null when no cap is breached.
function checkCostCap(metrics, costCap) {
  if (!costCap) return null;
  for (const [cur, cap] of Object.entries(costCap)) {
    if (!Number.isFinite(cap) || cap <= 0) continue;
    const spent = metrics.costsByCurrency[cur] || 0;
    if (spent >= cap) return { currency: cur, spent: Math.round(spent * 1_000_000) / 1_000_000, cap };
  }
  return null;
}

// Bump per-handler metrics from a single request's cost+usage. Keys
// cost by currency so heterogeneous fleets (USD-priced anthropic, EUR
// regional contracts) don't silently sum mismatched numbers. Tokens
// are unit-free → single counter.
function accumulateMetricsFromCost(metrics, usage, cost) {
  if (cost && Number.isFinite(cost.cost)) {
    const cur = cost.currency || 'USD';
    metrics.costsByCurrency[cur] = (metrics.costsByCurrency[cur] || 0) + cost.cost;
  }
  if (usage) {
    if (Number.isFinite(usage.inputTokens)) metrics.tokensTotal.inputTokens += usage.inputTokens;
    if (Number.isFinite(usage.outputTokens)) metrics.tokensTotal.outputTokens += usage.outputTokens;
  }
}

// Map provider error codes to HTTP statuses so clients can branch on
// res.status instead of parsing error messages. Returns
// { status, headers? } so 429 can attach a Retry-After.
//
// Exported for unit testing without spinning up an actual provider that
// would only fail under live network conditions.
export function statusForProviderError(err) {
  if (err?.code === 'INVALID_KEY') return { status: 401 };
  if (err?.code === 'RATE_LIMIT') {
    const retrySeconds = Math.max(1, Math.ceil((err.retryAfterMs || 1000) / 1000));
    return { status: 429, headers: { 'retry-after': String(retrySeconds) } };
  }
  if (err?.status && err.status >= 400 && err.status < 600) return { status: err.status };
  return { status: 502 };
}

function writeSseHead(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'close',
  });
}

function writeSse(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Constant-time string equality. Plain `===` would short-circuit on the
 * first mismatching byte, leaking timing info that lets an attacker on
 * a shared host narrow the secret one byte at a time. We compare every
 * byte with XOR + accumulator.
 */
function constantTimeEqual(a, b) {
  const aStr = String(a ?? '');
  const bStr = String(b ?? '');
  if (aStr.length !== bStr.length) return false;
  let diff = 0;
  for (let i = 0; i < aStr.length; i++) {
    diff |= aStr.charCodeAt(i) ^ bStr.charCodeAt(i);
  }
  return diff === 0;
}

function isAuthorized(req, expectedToken) {
  if (!expectedToken) return true;  // auth disabled
  const header = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  return constantTimeEqual(m[1].trim(), expectedToken);
}

/**
 * Origin gate — protect against DNS-rebinding / CSRF where a page in
 * the user's browser posts to 127.0.0.1:<our port>. Browsers always
 * attach `Origin` for cross-origin POSTs (and increasingly for GETs);
 * CLI tools (curl, fetch from a script) usually don't.
 *
 * Policy:
 *   - No `Origin` header → assume non-browser caller, allow.
 *   - `Origin` set → must be in `allowedOrigins`. Empty allowlist
 *     means "reject all browser-originated requests" — the default,
 *     because the daemon is designed for CLI/script callers.
 *   - `allowLoopback: true` (set by `lazyclaw dashboard`) additionally
 *     accepts any `Origin` that looks like loopback (`http://127.0.0.1:*`,
 *     `http://localhost:*`, `http://[::1]:*`). Safe because the daemon
 *     binds only to 127.0.0.1, so an attacker can't reach us with a
 *     loopback Origin unless they're already on the box. DNS rebinding
 *     can't forge `127.0.0.1` as a hostname — that resolves before
 *     `fetch()` ever issues the request.
 *
 * Returns true when the request should proceed, false when it should
 * be rejected with 403.
 */
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
function isOriginAllowed(req, allowedOrigins, allowLoopback) {
  const origin = req.headers['origin'];
  if (!origin) return true;
  if (allowLoopback && LOOPBACK_ORIGIN_RE.test(origin)) return true;
  if (!allowedOrigins || allowedOrigins.length === 0) return false;
  return allowedOrigins.includes(origin);
}

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
    tokensTotal: { inputTokens: 0, outputTokens: 0 },
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
  process.on('SIGTERM', () => { _nudgeLoop.stop(); });
  process.on('SIGINT', () => { _nudgeLoop.stop(); });
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
      switch (true) {
        case route === 'GET /' || route === 'GET /dashboard': {
          // Serve the lazyclaw-only web dashboard (a single static
          // HTML in src/lazyclaw/web/). Co-resident with the JSON
          // API so a single port handles both — no CORS song and
          // dance, no separate static server. Falls back to a
          // helpful text response when the file is missing (someone
          // ran the daemon out of a partial install).
          try {
            const fs = await import('node:fs');
            const path = await import('node:path');
            const url = await import('node:url');
            const here = path.dirname(url.fileURLToPath(import.meta.url));
            const htmlPath = path.join(here, 'web', 'dashboard.html');
            const body = fs.readFileSync(htmlPath, 'utf8');
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-cache',
            });
            return res.end(body);
          } catch (e) {
            res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
            return res.end(
              `lazyclaw daemon is up but the dashboard HTML wasn't found.\n` +
              `Try \`lazyclaw version\` to confirm install integrity, or hit any /api endpoint directly.\n\n` +
              `error: ${e?.message || e}\n`,
            );
          }
        }
        case route === 'GET /version':
          return writeJson(res, 200, { version: ctx.version(), nodeVersion: process.version, platform: `${process.platform}-${process.arch}` });
        case route === 'POST /exec/request': {
          // Remote exec-approval bridge. This route is AUTH-TOKEN-GATED
          // (above), so only the trusted local operator/CLI can REQUEST an
          // approval; a paired mobile device RESOLVES it over the gateway
          // (POST /gateway/exec/resolve). The route long-polls: it awaits
          // the device's decision (or the approval's timeout) and returns
          // { approved, by, reason }.
          let body;
          try { body = await readJson(req); }
          catch (e) { return writeJson(res, 400, { error: `invalid JSON body: ${e.message}` }); }
          if (!body || typeof body.tool !== 'string' || !body.tool) {
            return writeJson(res, 400, { error: 'tool is required' });
          }
          const { promise } = gateway.requestApproval(
            { tool: body.tool, args: body.args, agentId: body.agentId, summary: body.summary },
            { timeoutMs: Number.isFinite(+body.timeoutMs) ? +body.timeoutMs : undefined },
          );
          const result = await promise;
          return writeJson(res, 200, result);
        }
        case route === 'GET /health':
        case route === 'GET /healthz':
          // Conventional liveness check — always 200 if the process
          // is alive enough to hit the route. No config inspection
          // (use /doctor for readiness), no provider probing — this
          // is the "is the daemon up?" probe that load balancers
          // and watchdog scripts expect at this path. m15: K8s
          // readiness probes default to /healthz so we alias.
          return writeJson(res, 200, {
            ok: true,
            status: 'alive',
            uptimeMs: Date.now() - metrics.startedAtMs,
            timestamp: new Date().toISOString(),
          });
        case route === 'GET /metrics': {
          // Aggregate per-handler counters. cacheStats are pulled per
          // wrapped provider — we report a sum across all populated
          // entries so the figure reflects total cache activity.
          let cacheHits = 0, cacheMisses = 0, cacheSize = 0;
          if (cachedByName) {
            for (const wrapped of cachedByName.values()) {
              const s = typeof wrapped.cacheStats === 'function' ? wrapped.cacheStats() : null;
              if (s) {
                cacheHits += s.hits || 0;
                cacheMisses += s.misses || 0;
                cacheSize += s.size || 0;
              }
            }
          }
          // Cumulative tokens / cost — meaningful only when callers used
          // body.usage / body.cost. The fields are always present (zero
          // by default) so monitoring tooling sees a stable schema.
          const tokensTotal = { ...metrics.tokensTotal };
          const costs = {};
          for (const [cur, n] of Object.entries(metrics.costsByCurrency)) {
            // Round to six decimals here too, matching costFromUsage's
            // precision so monitoring deltas line up with per-request
            // breakdowns.
            costs[cur] = Math.round(n * 1_000_000) / 1_000_000;
          }
          // Workflow snapshot — opportunistic. We scan the state dir
          // once per /metrics call and count per bucket. This is
          // cheap unless the user has thousands of state files; for
          // truly large fleets the operator can disable by passing
          // ctx.workflowMetrics === false.
          let workflows = null;
          if (ctx.workflowMetrics !== false) {
            try {
              const stateDir = ctx.workflowStateDir();
              if (fs.existsSync(stateDir)) {
                const sessions = listWorkflowSessions(stateDir);
                workflows = { total: sessions.length, done: 0, resumable: 0, failed: 0, running: 0 };
                for (const s of sessions) {
                  if (s.summary.done)        workflows.done++;
                  if (s.summary.resumable)   workflows.resumable++;
                  if (s.summary.failed > 0)  workflows.failed++;
                  if (s.summary.running > 0) workflows.running++;
                }
              } else {
                workflows = { total: 0, done: 0, resumable: 0, failed: 0, running: 0 };
              }
            } catch {
              // Don't fail /metrics because the state dir is unreadable —
              // expose the gap as null and keep monitoring alive.
              workflows = null;
            }
          }
          return writeJson(res, 200, {
            uptimeMs: Date.now() - metrics.startedAtMs,
            requestsTotal: metrics.requestsTotal,
            requestsByStatus: metrics.requestsByStatus,
            rateLimitDenied: metrics.rateLimitDenied,
            cache: cachedByName ? { hits: cacheHits, misses: cacheMisses, size: cacheSize } : null,
            tokensTotal,
            costsByCurrency: costs,
            workflows,
            timestamp: new Date().toISOString(),
          });
        }
        case route === 'GET /providers': {
          // ?filter=<substr>&limit=<N> mirror v3.33+ list flags.
          // The dashboard reads `custom` / `builtinOpenAICompat` / `endpoint`
          // / `docs` to render the right pills + tooltips; CLI callers only
          // need `name` / `requiresApiKey` / `suggestedModels` and ignore
          // the extras (additive change, no migration).
          let out = Object.keys(PROVIDERS).map(name => {
            const meta = PROVIDER_INFO[name] || { name };
            return {
              name,
              requiresApiKey: !!meta.requiresApiKey,
              defaultModel: meta.defaultModel || null,
              suggestedModels: meta.suggestedModels || [],
              endpoint: meta.endpoint || null,
              docs: meta.docs || null,
              custom: !!meta.custom,
              builtinOpenAICompat: !!meta.builtinOpenAICompat,
              baseUrl: meta.baseUrl || null,
              envKey: meta.envKey || null,
              keyPrefix: meta.keyPrefix || null,
            };
          });
          const filter = url.searchParams.get('filter');
          if (filter) {
            const f = filter.toLowerCase();
            out = out.filter(p => p.name.toLowerCase().includes(f));
          }
          const limitStr = url.searchParams.get('limit');
          if (limitStr) {
            const n = parseInt(limitStr, 10);
            if (Number.isFinite(n) && n > 0) out = out.slice(0, n);
          }
          return writeJson(res, 200, out);
        }
        case req.method === 'GET' && !!providerMatch && providerMatch[1] !== 'test': {
          // GET /providers/<name> — full per-provider metadata
          // (mirrors CLI `lazyclaw providers info <name>`).
          // The `name !== 'test'` guard keeps `/providers/test`
          // (parallel batch endpoint) from being intercepted here;
          // switch-case order ensures the literal `GET /providers/test`
          // case runs first anyway, but the guard makes the intent
          // explicit for future readers.
          const name = providerMatch[1];
          const meta = PROVIDER_INFO[name];
          if (!meta) {
            return writeJson(res, 404, {
              error: 'unknown provider',
              name,
              knownProviders: Object.keys(PROVIDERS),
            });
          }
          return writeJson(res, 200, meta);
        }
        case route === 'GET /providers/test': {
          // Mirror of CLI v3.55 `lazyclaw providers test` (no name).
          // A dashboard's "key validity" badge calls this once and
          // gets a per-provider verdict in one round trip. HTTP
          // status mirrors CLI exit code:
          //   200 — every provider returned a non-empty reply
          //   503 — at least one provider failed (Service Unavailable;
          //         "the system is partially unhealthy")
          // 503 is the right code because a dashboard observing it
          // can render a yellow status without parsing the body.
          const cfg = ctx.readConfig();
          const apiKey = cfg['api-key'] || '';
          const sharedPrompt = url.searchParams.get('prompt') || 'ping';
          const tAll = Date.now();
          const results = await Promise.all(
            Object.entries(PROVIDERS).map(async ([pid, provider]) => {
              const meta = PROVIDER_INFO[pid] || {};
              const model = url.searchParams.get('model') || cfg.model || meta.defaultModel || 'unknown';
              const t0 = Date.now();
              try {
                let reply = '';
                const stream = provider.sendMessage([{ role: 'user', content: sharedPrompt }], { apiKey, model });
                for await (const chunk of stream) {
                  if (typeof chunk === 'string') reply += chunk;
                }
                return {
                  name: pid, ok: reply.length > 0, model,
                  durationMs: Date.now() - t0,
                  replyLength: reply.length,
                };
              } catch (err) {
                return {
                  name: pid, ok: false, model,
                  durationMs: Date.now() - t0,
                  error: err?.message || String(err),
                  code: err?.code || null,
                };
              }
            }),
          );
          const allOk = results.every(r => r.ok);
          return writeJson(res, allOk ? 200 : 503, {
            ok: allOk,
            totalDurationMs: Date.now() - tAll,
            results,
          });
        }
        case req.method === 'GET' && !!providerTestMatch: {
          // GET /providers/<name>/test — single-provider 1-token reachability
          // probe. Same shape as one entry of GET /providers/test, but the
          // endpoint stops on the first failure and exposes the reply body
          // (truncated) so the dashboard can show a real signal of life.
          const name = providerTestMatch[1];
          const provider = PROVIDERS[name];
          if (!provider) return writeJson(res, 404, { error: `unknown provider: ${name}` });
          const cfg = ctx.readConfig();
          const apiKey = cfg['api-key'] || '';
          const meta = PROVIDER_INFO[name] || {};
          const model = url.searchParams.get('model') || cfg.model || meta.defaultModel || 'unknown';
          const prompt = url.searchParams.get('prompt') || 'ping';
          const t0 = Date.now();
          try {
            let reply = '';
            const stream = provider.sendMessage([{ role: 'user', content: prompt }], { apiKey, model });
            for await (const chunk of stream) {
              if (typeof chunk === 'string') reply += chunk;
            }
            return writeJson(res, reply.length > 0 ? 200 : 503, {
              ok: reply.length > 0,
              name, model,
              durationMs: Date.now() - t0,
              replyLength: reply.length,
              reply: reply.slice(0, 500),
            });
          } catch (err) {
            return writeJson(res, 503, {
              ok: false, name, model,
              durationMs: Date.now() - t0,
              error: err?.message || String(err),
              code: err?.code || null,
            });
          }
        }
        case route === 'POST /providers': {
          // Register or overwrite a custom OpenAI-compatible provider.
          // Body: { name, baseUrl, apiKey?, defaultModel? }. Persists into
          // cfg.customProviders[] and hot-registers via the registry's
          // registerCustomProviders() so the new entry is callable in this
          // same process. 405 when the daemon was started without
          // writeConfig (read-only mode). The same name as a built-in
          // OpenAI-compat alias is allowed and overrides the built-in.
          if (typeof ctx.writeConfig !== 'function') {
            return writeJson(res, 405, { error: 'mutation disabled — daemon was started without writeConfig' });
          }
          let body;
          try { body = await readJson(req); }
          catch (e) { return writeJson(res, 400, { error: e?.message || String(e) }); }
          const reg = await import('./providers/registry.mjs');
          let name;
          try { name = reg.validateCustomProviderName(body.name); }
          catch (e) { return writeJson(res, 400, { error: e.message }); }
          if (!body.baseUrl || typeof body.baseUrl !== 'string' || !/^https?:\/\//i.test(body.baseUrl)) {
            return writeJson(res, 400, { error: 'baseUrl must be a string starting with http:// or https://' });
          }
          const cfg = ctx.readConfig();
          cfg.customProviders = Array.isArray(cfg.customProviders) ? cfg.customProviders : [];
          const idx = cfg.customProviders.findIndex((p) => p && p.name === name);
          const entry = {
            name,
            baseUrl: String(body.baseUrl).replace(/\/+$/, ''),
            apiKey: body.apiKey || undefined,
            defaultModel: body.defaultModel || undefined,
          };
          if (idx >= 0) cfg.customProviders[idx] = { ...cfg.customProviders[idx], ...entry };
          else cfg.customProviders.push(entry);
          ctx.writeConfig(cfg);
          try { reg.registerCustomProviders(cfg); } catch { /* keep going */ }
          const overridesBuiltin = typeof reg.isBuiltinOpenAICompatName === 'function'
            ? reg.isBuiltinOpenAICompatName(name)
            : false;
          return writeJson(res, 200, { ok: true, name, baseUrl: entry.baseUrl, overridesBuiltin });
        }
        case req.method === 'DELETE' && !!providerMatch && providerMatch[1] !== 'test': {
          // DELETE /providers/<name> — drop a custom registration. Idempotent:
          // 200 with `removed: false` when the name wasn't a custom entry.
          // Built-in providers can't be deleted; their PROVIDERS row is
          // restored on next process boot if the user previously overrode it.
          if (typeof ctx.writeConfig !== 'function') {
            return writeJson(res, 405, { error: 'mutation disabled' });
          }
          const name = providerMatch[1];
          const cfg = ctx.readConfig();
          if (!Array.isArray(cfg.customProviders) || cfg.customProviders.length === 0) {
            return writeJson(res, 200, { ok: true, name, removed: false });
          }
          const before = cfg.customProviders.length;
          cfg.customProviders = cfg.customProviders.filter((p) => !(p && p.name === name));
          const removed = cfg.customProviders.length < before;
          if (removed) ctx.writeConfig(cfg);
          return writeJson(res, 200, { ok: true, name, removed });
        }
        case route === 'GET /rates': {
          // Read-only view of cfg.rates so a dashboard's cost panel
          // can render the configured cards without shelling to the
          // CLI. No write surface exposed — rate-card edits go
          // through the CLI (operator-curated, deliberate).
          // ?filter=<substr>&limit=<N> mirror v3.33+ list flags.
          const cfg = ctx.readConfig();
          const rates = cfg.rates && typeof cfg.rates === 'object' ? cfg.rates : {};
          let entries = Object.entries(rates);
          const filter = url.searchParams.get('filter');
          if (filter) {
            const f = filter.toLowerCase();
            entries = entries.filter(([key]) => key.toLowerCase().includes(f));
          }
          const limitStr = url.searchParams.get('limit');
          if (limitStr) {
            const n = parseInt(limitStr, 10);
            if (Number.isFinite(n) && n > 0) entries = entries.slice(0, n);
          }
          return writeJson(res, 200, Object.fromEntries(entries));
        }
        case route === 'GET /rates/validate': {
          // Mirror of v3.30's `lazyclaw rates validate`. Same shape
          // (single source of truth in rates-validate.mjs). HTTP
          // status reflects ok/issues so a UI's cost-config badge
          // can branch on HTTP code: 200 ok, 422 issues
          // (Unprocessable Entity, same pattern as /config/validate
          // in v3.40).
          const cfg = ctx.readConfig();
          const result = validateRates(cfg.rates, PROVIDERS);
          return writeJson(res, result.ok ? 200 : 422, result);
        }
        case route === 'GET /rates/shape': {
          // Mirror of `lazyclaw rates shape`. Returns the zero-filled
          // reference rate-card template so a dashboard config panel
          // or a script that scaffolds a new card can get the required
          // fields without shelling to the CLI.
          return writeJson(res, 200, RATE_CARD_SHAPE);
        }
        case req.method === 'PUT' && !!ratesKeyMatch && ratesKeyMatch[1] !== 'validate' && ratesKeyMatch[1] !== 'shape': {
          // PUT /rates/<key> — set a rate card. Body is the card object
          // ({ in, out, "cache-read"?, "cache-create"?, currency? }). The
          // payload is merged into cfg.rates and validated as a whole;
          // 422 on validation failure. 405 when writeConfig is unset.
          if (typeof ctx.writeConfig !== 'function') {
            return writeJson(res, 405, { error: 'mutation disabled' });
          }
          const key = decodeURIComponent(ratesKeyMatch[1]);
          let body;
          try { body = await readJson(req); }
          catch (e) { return writeJson(res, 400, { error: e?.message || String(e) }); }
          if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'body must be a JSON object' });
          const cfg = ctx.readConfig();
          cfg.rates = cfg.rates && typeof cfg.rates === 'object' ? cfg.rates : {};
          cfg.rates[key] = body;
          const v = validateRates(cfg.rates, PROVIDERS);
          if (!v.ok) return writeJson(res, 422, v);
          ctx.writeConfig(cfg);
          return writeJson(res, 200, { ok: true, key, card: cfg.rates[key] });
        }
        case req.method === 'DELETE' && !!ratesKeyMatch && ratesKeyMatch[1] !== 'validate' && ratesKeyMatch[1] !== 'shape': {
          // DELETE /rates/<key> — idempotent: 200 with `removed: false`
          // when the card didn't exist.
          if (typeof ctx.writeConfig !== 'function') {
            return writeJson(res, 405, { error: 'mutation disabled' });
          }
          const key = decodeURIComponent(ratesKeyMatch[1]);
          const cfg = ctx.readConfig();
          if (!cfg.rates || typeof cfg.rates !== 'object' || !(key in cfg.rates)) {
            return writeJson(res, 200, { ok: true, key, removed: false });
          }
          delete cfg.rates[key];
          ctx.writeConfig(cfg);
          return writeJson(res, 200, { ok: true, key, removed: true });
        }
        case route === 'GET /status': {
          const cfg = ctx.readConfig();
          // v5: surface a one-line summary of trainer / index / sandbox so
          // the dashboard banner doesn't need three more round-trips.
          const trainerCfg = (cfg.trainer && typeof cfg.trainer === 'object') ? cfg.trainer : {};
          const sandboxBackend = (cfg.sandbox && typeof cfg.sandbox === 'object' && cfg.sandbox.default) || 'local';
          let indexRows = null;
          try {
            const db = indexDb.openIndex(gwConfigDir, { runIntegrityCheck: false });
            const r = db.prepare(
              "SELECT (SELECT COUNT(*) FROM fts_sessions) + (SELECT COUNT(*) FROM fts_skills) " +
              " + (SELECT COUNT(*) FROM fts_trajectories) + (SELECT COUNT(*) FROM fts_memories) AS n"
            ).get();
            indexRows = r && typeof r.n === 'number' ? r.n : null;
          } catch { /* index may not exist yet */ }
          // Migration backup path is conventionally <configDir>/backup-v4/.
          let migrateBackup = null;
          try {
            const p = nodePath.join(gwConfigDir || skillsDefaultConfigDir(), 'backup-v4');
            if (fs.existsSync(p)) migrateBackup = p;
          } catch { /* ignore */ }
          return writeJson(res, 200, {
            provider: cfg.provider || null,
            model: cfg.model || null,
            keyMasked: maskApiKey(cfg['api-key']),
            v5: {
              trainer: {
                provider: trainerCfg.provider || null,
                model: trainerCfg.model || null,
              },
              sandboxBackend,
              indexRows,
              migrateBackup,
            },
          });
        }
        case route === 'GET /config/validate': {
          // Mirror of v3.39's `lazyclaw config validate`. Same shape
          // (single source of truth in config-validate.mjs). HTTP
          // status reflects ok/issues so a UI's "config status"
          // badge can branch on HTTP code: 200 = ok, 422 = issues
          // (Unprocessable Entity — semantically right for "the
          // config you supplied is malformed").
          const cfg = ctx.readConfig();
          const { ok, issues, warnings } = validateConfig(cfg, PROVIDERS);
          return writeJson(res, ok ? 200 : 422, {
            ok,
            keys: Object.keys(cfg),
            issues,
            warnings,
          });
        }
        case route === 'GET /config': {
          // Mirror of `lazyclaw config list`. Returns every stored key
          // with the api-key value masked — lets a dashboard or script
          // inspect the active configuration without shelling to the CLI.
          const cfg = ctx.readConfig();
          const safe = { ...cfg };
          if (safe['api-key']) safe['api-key'] = maskApiKey(safe['api-key']);
          return writeJson(res, 200, safe);
        }
        case req.method === 'GET' && !!configKeyMatch && configKeyMatch[1] !== 'validate': {
          // Mirror of `lazyclaw config get <key>`. The `!== 'validate'`
          // guard ensures the literal GET /config/validate case (above)
          // is never shadowed by this dynamic handler.
          const key = configKeyMatch[1];
          const cfg = ctx.readConfig();
          if (!(key in cfg)) {
            return writeJson(res, 404, { error: 'key not found', key });
          }
          const raw = cfg[key];
          const value = key === 'api-key' ? maskApiKey(raw) : raw;
          return writeJson(res, 200, { key, value });
        }
        case req.method === 'PUT' && !!configKeyMatch && configKeyMatch[1] !== 'validate': {
          // PUT /config/<key>  body: { value: <any> }
          // Mirror of `lazyclaw config set <key> <value>`. Re-validates the
          // whole config after the write so we never persist a broken state.
          // Nested cargo (customProviders / rates / authProfiles) goes
          // through its own dedicated endpoint — guarded here so a
          // dashboard PUT can't bypass schema validation.
          if (typeof ctx.writeConfig !== 'function') {
            return writeJson(res, 405, { error: 'mutation disabled' });
          }
          const key = configKeyMatch[1];
          if (key === 'customProviders' || key === 'rates' || key === 'authProfiles') {
            return writeJson(res, 400, {
              error: `use the dedicated endpoint for "${key}" — POST /providers · PUT /rates/<key> · authProfiles via CLI`,
            });
          }
          let body;
          try { body = await readJson(req); }
          catch (e) { return writeJson(res, 400, { error: e?.message || String(e) }); }
          const value = body && Object.prototype.hasOwnProperty.call(body, 'value') ? body.value : undefined;
          const cfg = ctx.readConfig();
          if (value === null || value === undefined) delete cfg[key];
          else cfg[key] = value;
          const v = validateConfig(cfg, PROVIDERS);
          if (!v.ok) return writeJson(res, 422, v);
          ctx.writeConfig(cfg);
          const stored = key === 'api-key' && typeof cfg[key] === 'string' ? maskApiKey(cfg[key]) : cfg[key];
          return writeJson(res, 200, { ok: true, key, value: stored });
        }
        case req.method === 'DELETE' && !!configKeyMatch && configKeyMatch[1] !== 'validate': {
          // DELETE /config/<key> — same as `lazyclaw config delete`.
          // Idempotent: 200 with `removed: false` when the key wasn't
          // present.
          if (typeof ctx.writeConfig !== 'function') {
            return writeJson(res, 405, { error: 'mutation disabled' });
          }
          const key = configKeyMatch[1];
          if (key === 'customProviders' || key === 'rates' || key === 'authProfiles') {
            return writeJson(res, 400, { error: `delete via the dedicated endpoint for "${key}"` });
          }
          const cfg = ctx.readConfig();
          if (!(key in cfg)) return writeJson(res, 200, { ok: true, key, removed: false });
          delete cfg[key];
          ctx.writeConfig(cfg);
          return writeJson(res, 200, { ok: true, key, removed: true });
        }
        case route === 'GET /doctor': {
          // Mirror the CLI doctor output — same field set so any tool that
          // already knows how to read CLI doctor JSON can hit this endpoint.
          const cfg = ctx.readConfig();
          const issues = [];
          if (!cfg.provider) issues.push('config.provider is missing');
          if (cfg.provider && cfg.provider !== 'mock' && !cfg['api-key']) {
            issues.push(`config['api-key'] is missing for provider "${cfg.provider}"`);
          }
          if (cfg.provider && !Object.prototype.hasOwnProperty.call(PROVIDERS, cfg.provider)) {
            issues.push(`unknown provider "${cfg.provider}"`);
          }
          // v5: FTS5 index integrity. Failure here is degraded-not-fatal —
          // surfaced as an issue but doesn't take the daemon down.
          let indexBlock = null;
          try {
            const integ = indexDb.integrityCheck(gwConfigDir);
            const db = indexDb.openIndex(gwConfigDir, { runIntegrityCheck: false });
            const rowCounts = {};
            for (const t of ['fts_sessions', 'fts_skills', 'fts_trajectories', 'fts_memories']) {
              try { rowCounts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; }
              catch { rowCounts[t] = null; }
            }
            indexBlock = {
              ok: !!integ.ok,
              result: integ.result || null,
              rowCounts,
              lastRebuiltAt: ctx.indexLastRebuiltAt || null,
            };
            if (!integ.ok) issues.push(`FTS5 index integrity_check returned ${integ.result}`);
          } catch (e) {
            indexBlock = { ok: false, error: e?.message || String(e), rowCounts: {}, lastRebuiltAt: null };
            issues.push(`FTS5 index unavailable: ${e?.message || e}`);
          }
          const ok = issues.length === 0;
          return writeJson(res, ok ? 200 : 503, {
            ok,
            provider: cfg.provider || null,
            model: cfg.model || null,
            hasApiKey: !!cfg['api-key'],
            nodeVersion: process.version,
            platform: `${process.platform}-${process.arch}`,
            issues,
            knownProviders: Object.keys(PROVIDERS),
            index: indexBlock,
            timestamp: new Date().toISOString(),
          });
        }
        case route === 'GET /sessions': {
          // ?filter=<substr> case-insensitive id substring;
          // ?limit=<N> caps post-filter count.
          // Same composition (filter then limit) as v3.33's CLI flag.
          // ?withTurnCount=true mirrors CLI v3.59's --with-turn-count;
          // opt-in because it loads each session file.
          // ?sortBy=mtime|turn-count|bytes|id mirrors CLI v3.60's --sort-by;
          // turn-count implicitly enables turn-count loading.
          const cfgDir = ctx.sessionsDirGetter();
          let list = ctx.sessionsMod.listSessions(cfgDir);
          const filter = url.searchParams.get('filter');
          if (filter) {
            const f = filter.toLowerCase();
            list = list.filter(s => s.id.toLowerCase().includes(f));
          }
          const limitStr = url.searchParams.get('limit');
          if (limitStr) {
            const n = parseInt(limitStr, 10);
            if (Number.isFinite(n) && n > 0) list = list.slice(0, n);
          }
          const sortBy = url.searchParams.get('sortBy');
          const validSortBy = new Set(['mtime', 'turn-count', 'bytes', 'id']);
          if (sortBy && !validSortBy.has(sortBy)) {
            return writeJson(res, 400, { error: `invalid sortBy: ${sortBy} (expected: mtime, turn-count, bytes, id)` });
          }
          const withCount = url.searchParams.get('withTurnCount') === 'true' || sortBy === 'turn-count';
          // v5: surface trainerHandled / agentName / trajectoryId per row.
          // Source: the last turn's metadata if persisted; otherwise null.
          // We're surgical here — we read the metadata only when withTurnCount
          // is already paying the load cost, OR when the dashboard explicitly
          // asks via ?withV5=true. Keeps the default GET /sessions cheap.
          const withV5 = url.searchParams.get('withV5') === 'true' || withCount;
          let out = list.map(s => {
            const base = { id: s.id, bytes: s.bytes, mtime: new Date(s.mtimeMs).toISOString(), _mtimeMs: s.mtimeMs };
            if (withCount) {
              try { base.turnCount = ctx.sessionsMod.loadTurns(s.id, cfgDir).length; }
              catch { base.turnCount = null; }
            }
            if (withV5) {
              try {
                const turns = ctx.sessionsMod.loadTurns(s.id, cfgDir);
                // Newest turn carries the freshest annotations. Fall back to
                // any earlier turn that has the field set so a long session
                // doesn't drop its trainer/agent attribution.
                let trainerHandled = false;
                let trainedBy = null;
                let agentName = null;
                let trajectoryId = null;
                for (let i = turns.length - 1; i >= 0; i--) {
                  const t = turns[i] || {};
                  if (!trajectoryId && t.trajectoryId) trajectoryId = String(t.trajectoryId);
                  if (!agentName && t.agent) agentName = String(t.agent);
                  if (!trainedBy && t.trainedBy) { trainedBy = String(t.trainedBy); trainerHandled = true; }
                  if (t.trainerHandled) trainerHandled = true;
                  if (trajectoryId && agentName && trainedBy) break;
                }
                base.trainerHandled = !!trainerHandled;
                base.trainedBy = trainedBy;
                base.agentName = agentName;
                base.trajectoryId = trajectoryId;
              } catch { /* missing metadata is non-fatal */ }
            }
            return base;
          });
          if (sortBy) {
            const cmp = {
              mtime:        (a, b) => b._mtimeMs - a._mtimeMs,
              'turn-count': (a, b) => (b.turnCount ?? 0) - (a.turnCount ?? 0),
              bytes:        (a, b) => b.bytes - a.bytes,
              id:           (a, b) => a.id.localeCompare(b.id),
            };
            out.sort(cmp[sortBy]);
          }
          return writeJson(res, 200, out.map(({ _mtimeMs, ...rest }) => rest));
        }
        case route === 'GET /sessions/search': {
          // Mirror of `lazyclaw sessions search <query> [--regex]`.
          // ?q=<query> required; ?regex=true switches to regex mode.
          // Returns { query, regex, matches: [{ id, mtime, matchCount, excerpt }] }
          // — same shape the CLI prints. A dashboard rendering the
          // search box can use the same parser for both surfaces.
          const q = url.searchParams.get('q');
          if (!q) return writeJson(res, 400, { error: 'missing q query parameter' });
          const useRegex = url.searchParams.get('regex') === 'true';
          let matcher;
          if (useRegex) {
            try { matcher = new RegExp(q, 'i'); }
            catch (e) { return writeJson(res, 400, { error: `invalid regex: ${e.message}` }); }
          } else {
            const ql = q.toLowerCase();
            matcher = { test: (s) => String(s).toLowerCase().includes(ql) };
          }
          const cfgDir = ctx.sessionsDirGetter();
          const list = ctx.sessionsMod.listSessions(cfgDir);
          const matches = [];
          for (const s of list) {
            const turns = ctx.sessionsMod.loadTurns(s.id, cfgDir);
            let matchCount = 0;
            let firstExcerpt = null;
            for (const t of turns) {
              if (typeof t?.content !== 'string') continue;
              if (matcher.test(t.content)) {
                matchCount++;
                if (firstExcerpt === null) {
                  const c = t.content;
                  let pos = useRegex ? c.search(matcher) : c.toLowerCase().indexOf(q.toLowerCase());
                  if (pos < 0) pos = 0;
                  const start = Math.max(0, pos - 40);
                  const end = Math.min(c.length, pos + q.length + 40);
                  firstExcerpt = (start > 0 ? '…' : '') + c.slice(start, end) + (end < c.length ? '…' : '');
                }
              }
            }
            if (matchCount > 0) {
              matches.push({
                id: s.id,
                mtime: new Date(s.mtimeMs).toISOString(),
                matchCount,
                excerpt: firstExcerpt,
              });
            }
          }
          return writeJson(res, 200, { query: q, regex: useRegex, matches });
        }
        case req.method === 'GET' && !!sessionExportMatch: {
          // GET /sessions/<id>/export?format=md|json|text — same body
          // the CLI's `lazyclaw sessions export <id> --format ...`
          // produces, with the appropriate content-type. The dashboard
          // can offer a "download as ..." button without spawning the
          // CLI.
          const id = sessionExportMatch[1];
          try {
            const cfgDir = ctx.sessionsDirGetter();
            const file = ctx.sessionsMod.sessionPath(id, cfgDir);
            if (!(await fileExists(file))) return writeJson(res, 404, { error: 'session not found', id });
            const fmt = (url.searchParams.get('format') || 'md').toLowerCase();
            const FORMATS = {
              md:       { fn: ctx.sessionsMod.exportMarkdown, mime: 'text/markdown; charset=utf-8' },
              markdown: { fn: ctx.sessionsMod.exportMarkdown, mime: 'text/markdown; charset=utf-8' },
              json:     { fn: ctx.sessionsMod.exportJson,     mime: 'application/json; charset=utf-8' },
              text:     { fn: ctx.sessionsMod.exportText,     mime: 'text/plain; charset=utf-8' },
              txt:      { fn: ctx.sessionsMod.exportText,     mime: 'text/plain; charset=utf-8' },
            };
            const f = FORMATS[fmt];
            if (!f) {
              return writeJson(res, 400, {
                error: `unknown format: ${fmt}`,
                expected: ['md', 'json', 'text'],
              });
            }
            const body = f.fn(id, cfgDir);
            res.writeHead(200, {
              'content-type': f.mime,
              'content-length': Buffer.byteLength(body),
            });
            return res.end(body);
          } catch (err) {
            return writeJson(res, 400, { error: err?.message || String(err) });
          }
        }
        case req.method === 'GET' && !!sessionMatch: {
          // GET /sessions/<id> — full turn log. Returns 404 when missing
          // rather than an empty array so the caller can distinguish
          // "session does not exist" from "session is empty".
          const id = sessionMatch[1];
          try {
            const cfgDir = ctx.sessionsDirGetter();
            const file = ctx.sessionsMod.sessionPath(id, cfgDir);
            if (!(await fileExists(file))) return writeJson(res, 404, { error: 'session not found', id });
            const turns = ctx.sessionsMod.loadTurns(id, cfgDir);
            return writeJson(res, 200, { id, turns });
          } catch (err) {
            return writeJson(res, 400, { error: err?.message || String(err) });
          }
        }
        case route === 'GET /workflows/aggregate': {
          // Mirror of CLI v3.48 `lazyclaw inspect --aggregate`. Per-node
          // statistics across every persisted session in the state
          // directory. Answers "which node tends to be slow / fail
          // across all my runs?" — needs no workflow file, just state.
          // ?filter=<substr> applies before aggregation (v3.50).
          const stateDir = ctx.workflowStateDir();
          const qFilter = url.searchParams.get('filter');
          const qNode = url.searchParams.get('node');
          try {
            const stats = aggregateNodeStats(stateDir, { filter: qFilter });
            // ?node=<id>: drill into one node's cross-session stats
            // (mirrors CLI v3.52 --aggregate --node). 404 when the
            // node never appeared in any session.
            if (qNode) {
              const nodeStat = stats.nodeStats[qNode];
              if (!nodeStat) {
                return writeJson(res, 404, {
                  error: 'node not found across sessions',
                  nodeId: qNode,
                  knownNodes: Object.keys(stats.nodeStats),
                });
              }
              return writeJson(res, 200, {
                dir: stateDir,
                filter: qFilter || null,
                sessionCount: stats.sessionCount,
                nodeId: qNode,
                ...nodeStat,
              });
            }
            return writeJson(res, 200, { dir: stateDir, filter: qFilter || null, ...stats });
          } catch (err) {
            if (err?.code === 'ENOENT') {
              return writeJson(res, 200, { dir: stateDir, filter: qFilter || null, sessionCount: 0, nodeStats: {} });
            }
            return writeJson(res, 500, { error: err?.message || String(err) });
          }
        }
        case route === 'GET /workflows': {
          // List every persisted workflow session in the configured
          // state dir, newest activity first. Mirrors `lazyclaw inspect`
          // (no-arg) exactly so a dashboard can use the same renderer
          // for CLI and HTTP outputs. Per-node `nodes` map is omitted —
          // call /workflows/<sessionId> for full detail.
          //
          // ?status=done|resumable|failed|running mirrors the CLI's
          // --status flag — one shared predicate so a UI can paginate
          // by bucket without pulling the full list.
          const stateDir = ctx.workflowStateDir();
          const qStatus = url.searchParams.get('status');
          if (qStatus) {
            const valid = new Set(['done', 'resumable', 'failed', 'running']);
            if (!valid.has(qStatus)) {
              return writeJson(res, 400, {
                error: `invalid status: ${qStatus}`,
                expected: [...valid],
              });
            }
          }
          try {
            let sessions = listWorkflowSessions(stateDir);
            if (qStatus) {
              sessions = sessions.filter(s => {
                if (qStatus === 'done')      return s.summary.done;
                if (qStatus === 'resumable') return s.summary.resumable;
                if (qStatus === 'failed')    return s.summary.failed > 0;
                if (qStatus === 'running')   return s.summary.running > 0;
                return true;
              });
            }
            // ?filter=<substr>&limit=<N> mirror v3.33 sessions/skills list flags.
            const qFilter = url.searchParams.get('filter');
            if (qFilter) {
              const f = qFilter.toLowerCase();
              sessions = sessions.filter(s => s.sessionId.toLowerCase().includes(f));
            }
            const qLimit = url.searchParams.get('limit');
            if (qLimit) {
              const n = parseInt(qLimit, 10);
              if (Number.isFinite(n) && n > 0) sessions = sessions.slice(0, n);
            }
            return writeJson(res, 200, { dir: stateDir, status: qStatus || null, sessions });
          } catch (err) {
            if (err?.code === 'ENOENT') {
              // Empty dir is a valid state (no workflows ever ran). The
              // CLI distinguishes "missing dir" from "empty dir" — the
              // daemon collapses both to an empty array so a fresh
              // process doesn't 404 a UI poll loop.
              return writeJson(res, 200, { dir: stateDir, status: qStatus || null, sessions: [] });
            }
            return writeJson(res, 500, { error: err?.message || String(err) });
          }
        }
        case req.method === 'GET' && !!workflowMatch: {
          // GET /workflows/<sessionId> — full state of a single
          // workflow run. Same shape as `lazyclaw inspect <id>` (the
          // engine's persisted object plus a derived summary block).
          // 404 when the state file is missing.
          const sid = workflowMatch[1];
          const stateDir = ctx.workflowStateDir();
          let state;
          try {
            state = loadWorkflowState(sid, stateDir);
          } catch (err) {
            return writeJson(res, 500, { error: err?.message || String(err) });
          }
          if (!state) return writeJson(res, 404, { error: 'workflow not found', sessionId: sid });
          // ?node=<id> drills into one node's state — same shape as
          // `lazyclaw inspect <session> --node <id>` (v3.41). The
          // HTTP status reflects the node's lifecycle (mirrors the
          // CLI exit codes): 200 success/pending/running, 410 Gone
          // for failed (request was valid, but the resource is in a
          // failed state), 404 for unknown node id.
          // ?slowest=<N>: top N nodes by durationMs. Same shape as
          // CLI v3.44 — pure state-file analysis, no deps needed.
          const qSlowest = url.searchParams.get('slowest');
          if (qSlowest) {
            const n = parseInt(qSlowest, 10);
            if (!Number.isFinite(n) || n <= 0) {
              return writeJson(res, 400, {
                error: `slowest must be a positive integer (got ${JSON.stringify(qSlowest)})`,
              });
            }
            const entries = Object.entries(state.nodes || {}).map(([id, ns]) => ({
              id,
              status: ns?.status || 'pending',
              durationMs: Number.isFinite(ns?.durationMs) ? ns.durationMs : 0,
              attempts: ns?.attempts ?? 0,
            }));
            entries.sort((a, b) => (b.durationMs - a.durationMs) || a.id.localeCompare(b.id));
            return writeJson(res, 200, {
              sessionId: state.sessionId,
              top: entries.slice(0, n),
            });
          }
          const qNode = url.searchParams.get('node');
          if (qNode) {
            const ns = state.nodes?.[qNode];
            if (!ns) {
              return writeJson(res, 404, {
                error: 'node not found',
                sessionId: sid,
                nodeId: qNode,
                knownNodes: Object.keys(state.nodes || {}),
              });
            }
            return writeJson(res, ns.status === 'failed' ? 410 : 200, {
              sessionId: state.sessionId,
              nodeId: qNode,
              ...ns,
            });
          }
          const { summary, failedNodes } = summarizeState(state);
          // ?summary=true trims the per-node `nodes` map and `order`
          // array, matching v3.17's CLI `inspect --summary` shape and
          // the per-session shape that list-mode produces. A UI fetching
          // this endpoint to render a status badge doesn't want the
          // full per-node payload — `?summary=true` keeps the wire
          // small for high-frequency polls.
          const compact = url.searchParams.get('summary') === 'true';
          const body = compact
            ? {
                sessionId: state.sessionId,
                dir: stateDir,
                summary,
                failedNodes,
                startedAt: state.startedAt,
                updatedAt: state.updatedAt,
              }
            : {
                sessionId: state.sessionId,
                dir: stateDir,
                summary,
                failedNodes,
                order: state.order,
                nodes: state.nodes,
                startedAt: state.startedAt,
                updatedAt: state.updatedAt,
              };
          return writeJson(res, 200, body);
        }
        case route === 'GET /skills': {
          // List installed skills with their first-line summary so a UI
          // can render them without a follow-up read for each one.
          // ?filter=<substr>&limit=<N> mirror the v3.33 CLI flags.
          const cfgDir = ctx.sessionsDirGetter();
          let items = listSkills(cfgDir);
          const filter = url.searchParams.get('filter');
          if (filter) {
            const f = filter.toLowerCase();
            items = items.filter(s => s.name.toLowerCase().includes(f));
          }
          const limitStr = url.searchParams.get('limit');
          if (limitStr) {
            const n = parseInt(limitStr, 10);
            if (Number.isFinite(n) && n > 0) items = items.slice(0, n);
          }
          // v5: include frontmatter fields the dashboard renders as badges.
          // listSkills() currently only surfaces name/summary/etc., so we
          // re-parse the body once per skill to extract trained_by /
          // confidence / cross_cli_tested / group. Cheap (markdown files,
          // already cached by the OS).
          const out = items.map((s) => {
            let meta = {};
            try {
              const body = loadSkill(s.name, cfgDir);
              meta = parseFrontmatter(body).meta || {};
            } catch { /* unreadable → empty meta */ }
            const xcli = meta.cross_cli_tested;
            return {
              name: s.name,
              bytes: s.bytes,
              summary: s.summary,
              description: meta.description || s.description || '',
              group: meta.group || '',
              trained_by: meta.trained_by || (meta.created_by === 'agent' ? 'agent' : ''),
              confidence: meta.confidence !== undefined && meta.confidence !== ''
                ? Number(meta.confidence)
                : null,
              cross_cli_tested: xcli === 'true' || xcli === true ? true
                : (Array.isArray(xcli) ? xcli : null),
              version: meta.version || s.version || '',
              created_by: meta.created_by || '',
            };
          });
          return writeJson(res, 200, out);
        }
        case route === 'GET /skills/suggestions': {
          // Ring buffer of nudge.suggest_skill events. Dashboard polls this
          // since the SSE bus is deferred to v5.1.
          return writeJson(res, 200, { suggestions: nudgeSuggestionsRing.slice(0, 20) });
        }
        case route === 'POST /skills/synth': {
          // Body: { sessionId: '<id>' [, outcome] [, trainedBy] [, model] }
          // Runs mas/skill_synth.synthesizeSkill against the named session.
          // We assemble a minimal agent stub from cfg.provider/model and an
          // empty role — the synth pipeline expects an agent object, but
          // most callers will want "use my default provider".
          let body;
          try { body = await readJson(req); }
          catch (e) { return writeJson(res, 400, { error: e?.message || String(e) }); }
          const sessionId = body && String(body.sessionId || '').trim();
          if (!sessionId) return writeJson(res, 400, { error: 'sessionId is required' });
          const cfg = ctx.readConfig();
          const provider = body.provider || cfg.provider;
          const model = body.model || cfg.model;
          if (!provider) return writeJson(res, 400, { error: 'no provider configured — set cfg.provider or pass body.provider' });
          // Pull the session turns and build a minimal task shape.
          let turns;
          try { turns = ctx.sessionsMod.loadTurns(sessionId, gwConfigDir); }
          catch (e) { return writeJson(res, 404, { error: `session not found: ${sessionId}` }); }
          if (!Array.isArray(turns) || turns.length === 0) {
            return writeJson(res, 400, { error: `session "${sessionId}" has no turns` });
          }
          const task = {
            id: sessionId,
            title: turns[0]?.content?.slice(0, 80) || sessionId,
            turns: turns.map((t) => ({
              agent: t.role === 'user' ? 'user' : (t.role === 'system' ? 'system' : 'assistant'),
              text: String(t.content || ''),
            })),
          };
          const agent = { provider, model, role: '' };
          try {
            const apiKey = cfg['api-key'] || null;
            const result = await skillSynth.synthesizeSkill({
              agent, task, apiKey,
              outcome: body.outcome || 'done',
              trainedBy: body.trainedBy || null,
              trainedOnModel: model || null,
            });
            if (!result) return writeJson(res, 200, { ok: false, message: 'synth produced no skill (model returned NONE)' });
            // Mirror the CLI synth flow: installSynthesized() handles slug
            // reservation, agent-overwrite protection, and FTS5 mirror.
            const install = skillSynth.installSynthesized({
              name: result.name,
              description: result.description,
              body: result.body,
              sourceTask: sessionId,
              createdBy: 'agent',
            }, gwConfigDir);
            return writeJson(res, 200, {
              ok: true,
              name: install?.skill || result.name,
              description: result.description,
              path: install?.path || null,
            });
          } catch (e) {
            return writeJson(res, 500, { error: e?.message || String(e), code: e?.code });
          }
        }
        case route === 'GET /skills/search': {
          // Mirror of `lazyclaw skills search`. ?q=<query> required;
          // ?regex=true switches to regex mode. Returns
          //   { query, regex, matches: [{ name, bytes, matchCount, excerpt }] }
          // — same shape the CLI prints. A dashboard skill picker can
          // hit this endpoint instead of pulling every skill body and
          // searching client-side.
          const q = url.searchParams.get('q');
          if (!q) return writeJson(res, 400, { error: 'missing q query parameter' });
          const useRegex = url.searchParams.get('regex') === 'true';
          let matcher;
          if (useRegex) {
            try { matcher = new RegExp(q, 'gi'); }
            catch (e) { return writeJson(res, 400, { error: `invalid regex: ${e.message}` }); }
          }
          const cfgDir = ctx.sessionsDirGetter();
          const items = listSkills(cfgDir);
          const matches = [];
          for (const s of items) {
            let body;
            try { body = loadSkill(s.name, cfgDir); } catch { continue; }
            let matchCount = 0;
            let firstExcerpt = null;
            if (useRegex) {
              for (const m of body.matchAll(matcher)) {
                matchCount++;
                if (firstExcerpt === null) {
                  const pos = m.index ?? 0;
                  const start = Math.max(0, pos - 40);
                  const end = Math.min(body.length, pos + m[0].length + 40);
                  firstExcerpt = (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '');
                }
              }
            } else {
              const lower = body.toLowerCase();
              const ql = q.toLowerCase();
              let pos = 0;
              while (true) {
                const i = lower.indexOf(ql, pos);
                if (i < 0) break;
                matchCount++;
                if (firstExcerpt === null) {
                  const start = Math.max(0, i - 40);
                  const end = Math.min(body.length, i + ql.length + 40);
                  firstExcerpt = (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '');
                }
                pos = i + ql.length;
              }
            }
            if (matchCount > 0) {
              matches.push({ name: s.name, bytes: s.bytes, matchCount, excerpt: firstExcerpt });
            }
          }
          return writeJson(res, 200, { query: q, regex: useRegex, matches });
        }
        case req.method === 'GET' && !!skillMatch: {
          // GET /skills/<name> — full markdown body as text/markdown.
          // 404 when the file is missing so the caller can branch.
          // 400 when the name fails skillPath validation (path traversal,
          // dotfile, etc.) — same protections as the CLI.
          // m13 — decodeURIComponent before validation (see PUT below).
          let name;
          try { name = decodeURIComponent(skillMatch[1]); }
          catch { return writeJson(res, 400, { error: 'malformed skill name' }); }
          try {
            const cfgDir = ctx.sessionsDirGetter();
            const file = skillPath(name, cfgDir);
            if (!(await fileExists(file))) return writeJson(res, 404, { error: 'skill not found', name });
            const body = loadSkill(name, cfgDir);
            res.writeHead(200, {
              'content-type': 'text/markdown; charset=utf-8',
              'content-length': Buffer.byteLength(body),
            });
            return res.end(body);
          } catch (err) {
            return writeJson(res, 400, { error: err?.message || String(err) });
          }
        }
        case req.method === 'PUT' && !!skillMatch: {
          // PUT /skills/<name>  body = markdown text
          //   201 on first write, 200 on overwrite (caller can branch on
          //   the status if they care about idempotency vs newness).
          //   400 on invalid name (skillPath validation) or oversize body.
          // m13 — decodeURIComponent the segment before validation so
          // a request like `PUT /skills/foo%2Fbar` is rejected as a path-
          // separator (slash) rather than letting the literal-percent
          // filename slip through.
          let name;
          try { name = decodeURIComponent(skillMatch[1]); }
          catch { return writeJson(res, 400, { error: 'malformed skill name' }); }
          const cfgDir = ctx.sessionsDirGetter();
          let priorExists = false;
          try {
            // Validate name before reading the body so a bogus name fails
            // fast and we don't waste bandwidth.
            const file = skillPath(name, cfgDir);
            priorExists = await fileExists(file);
          } catch (err) {
            return writeJson(res, 400, { error: err?.message || String(err) });
          }
          let body;
          try { body = await readTextBody(req); }
          catch (err) { return writeJson(res, 400, { error: err?.message || String(err) }); }
          try {
            const written = installSkill(name, body, cfgDir);
            return writeJson(res, priorExists ? 200 : 201, {
              ok: true, name, path: written, bytes: body.length, replaced: priorExists,
            });
          } catch (err) {
            return writeJson(res, 400, { error: err?.message || String(err) });
          }
        }
        case req.method === 'DELETE' && !!skillMatch: {
          // DELETE /skills/<name>  idempotent: 200 whether the file
          // existed or not, mirroring DELETE /sessions/<id>. The body
          // reports `removed: true|false` so callers can branch when
          // they care.
          // m13 — decodeURIComponent before validation (see PUT below).
          let name;
          try { name = decodeURIComponent(skillMatch[1]); }
          catch { return writeJson(res, 400, { error: 'malformed skill name' }); }
          const cfgDir = ctx.sessionsDirGetter();
          try {
            const file = skillPath(name, cfgDir);
            const existed = await fileExists(file);
            removeSkill(name, cfgDir);
            return writeJson(res, 200, { ok: true, name, removed: existed });
          } catch (err) {
            return writeJson(res, 400, { error: err?.message || String(err) });
          }
        }
        case req.method === 'DELETE' && !!sessionMatch: {
          // DELETE /sessions/<id> — idempotent. 200 on both "deleted" and
          // "didn't exist" so callers can use it as a reset without checking
          // first. m16: include `removed: <bool>` for shape parity with
          // sibling DELETEs (/skills, /workflows).
          const id = sessionMatch[1];
          try {
            // Use the sessions module's path resolver to check existence
            // BEFORE clearSession (which is unconditional unlink-if-exists).
            const sessDir = ctx.sessionsDirGetter();
            let existedBefore = false;
            try {
              const sessPath = ctx.sessionsMod.sessionPath
                ? ctx.sessionsMod.sessionPath(id, sessDir)
                : null;
              if (sessPath) existedBefore = fs.existsSync(sessPath);
            } catch { /* sessionPath unavailable → leave as unknown */ }
            ctx.sessionsMod.clearSession(id, sessDir);
            return writeJson(res, 200, { ok: true, id, removed: existedBefore });
          } catch (err) {
            return writeJson(res, 400, { error: err?.message || String(err) });
          }
        }
        case req.method === 'DELETE' && !!workflowMatch: {
          // DELETE /workflows/<sessionId> — idempotent: 200 with
          // `removed: true|false`. Same protection as the rest of the
          // delete routes — only files inside the configured state dir
          // are touched. The path matcher already rejects `..` and `/`,
          // and we re-resolve via path.join so a sessionId that resolves
          // outside the dir is rejected with 400.
          const sid = workflowMatch[1];
          const stateDir = ctx.workflowStateDir();
          // Note: `path` is shadowed inside this handler by the URL path
          // variable above — use `nodePath` (aliased import) for fs ops.
          const file = nodePath.join(stateDir, `${sid}.json`);
          // Confined-path check: file must resolve under stateDir. fs.realpathSync
          // would resolve symlinks too, but the dir may not exist yet — use
          // the resolved string-prefix check, which is enough since stateDir
          // is operator-controlled.
          const resolvedDir = nodePath.resolve(stateDir);
          const resolvedFile = nodePath.resolve(file);
          if (!resolvedFile.startsWith(resolvedDir + nodePath.sep) && resolvedFile !== resolvedDir) {
            return writeJson(res, 400, { error: 'invalid sessionId' });
          }
          try {
            const existed = fs.existsSync(resolvedFile);
            if (existed) fs.unlinkSync(resolvedFile);
            return writeJson(res, 200, { ok: true, sessionId: sid, removed: existed });
          } catch (err) {
            return writeJson(res, 500, { error: err?.message || String(err) });
          }
        }
        case route === 'POST /chat': {
          // Cost-cap gate: short-circuit before parsing the body so the
          // 402 fires fast and we don't pay for body buffering on a
          // request we're refusing.
          const breach = checkCostCap(metrics, costCap);
          if (breach) {
            return writeJson(res, 402, {
              error: 'cost cap exceeded',
              currency: breach.currency,
              spent: breach.spent,
              cap: breach.cap,
            });
          }
          // Full message-array input, single response (or stream). Useful when
          // the caller already has a message history and doesn't want to use
          // the disk-persisted session model.
          const body = await readJson(req);
          const cfg = ctx.readConfig();
          const provName = body.provider || cfg.provider || 'mock';
          const resolved = resolveProvider(body, provName, cachedByName, logger);
          if (resolved.error) return writeJson(res, 400, { error: resolved.error });
          const prov = resolved.provider;
          const messages = Array.isArray(body.messages) ? body.messages.filter(m => m && typeof m.role === 'string' && typeof m.content === 'string') : null;
          if (!messages || messages.length === 0) return writeJson(res, 400, { error: 'messages array required' });
          const thinkingBudget = Number(body.thinkingBudget) || 0;
          // Usage capture: opt-in via body.usage. The provider only does
          // the extra work (and pays the wire cost on OpenAI) when the
          // caller asks for it.
          let captured = null;
          const sendOpts = {
            apiKey: cfg['api-key'],
            model: body.model || cfg.model,
            thinking: thinkingBudget > 0 ? { enabled: true, budgetTokens: thinkingBudget } : undefined,
            onUsage: body.usage ? (u) => { captured = u; } : undefined,
          };
          // Cost lookup: body.cost:true asks the daemon to attach a cost
          // block when usage was captured AND cfg.rates has a card for
          // the active provider/model. Pure arithmetic — no extra wire
          // calls. Inline rather than helper-extract because the two
          // response paths (stream / non-stream) need to bind it
          // differently (SSE event vs JSON field).
          const computeCost = () => {
            if (!body.cost || !captured || !cfg.rates) return null;
            try {
              const c = costFromUsage(
                { provider: provName, model: body.model || cfg.model, usage: captured },
                cfg.rates,
              );
              if (c) accumulateMetricsFromCost(metrics, captured, c);
              return c;
            } catch { return null; }
          };
          if (body.stream === true) {
            writeSseHead(res);
            try {
              for await (const chunk of prov.sendMessage(messages, sendOpts)) {
                writeSse(res, 'token', { text: chunk });
                await new Promise(r => setImmediate(r));
              }
              if (captured) writeSse(res, 'usage', captured);
              const cost = computeCost();
              if (cost) writeSse(res, 'cost', cost);
              writeSse(res, 'done', { ok: true });
              return res.end();
            } catch (err) {
              writeSse(res, 'error', { message: err?.message || String(err) });
              return res.end();
            }
          }
          let acc = '';
          try {
            for await (const chunk of prov.sendMessage(messages, sendOpts)) acc += chunk;
            const cost = computeCost();
            const out = { reply: acc };
            if (captured) out.usage = captured;
            if (cost) out.cost = cost;
            return writeJson(res, 200, out);
          } catch (err) {
            const m = statusForProviderError(err);
            return writeJson(res, m.status, {
              error: err?.message || String(err),
              code: err?.code || null,
              ...(err?.retryAfterMs ? { retryAfterMs: err.retryAfterMs } : {}),
            }, m.headers || {});
          }
        }
        case route === 'POST /inbound': {
          // Generic inbound bridge — a stable, channel-agnostic relay
          // target so ANY platform (a Discord/WhatsApp/etc. bot the user
          // runs elsewhere) can forward a message in and get one reply,
          // without lazyclaw shipping that platform's SDK. Auth-token
          // gated like every non-gateway route; additionally pairing-gated
          // on senderId when a pairing allowlist is configured.
          const breach = checkCostCap(metrics, costCap);
          if (breach) return writeJson(res, 402, { error: 'cost cap exceeded', currency: breach.currency, spent: breach.spent, cap: breach.cap });
          let body;
          try { body = await readJson(req); }
          catch (e) { return writeJson(res, 400, { error: `invalid JSON body: ${e.message}` }); }
          const text = typeof body.text === 'string' ? body.text.trim() : '';
          if (!text) return writeJson(res, 400, { error: 'text is required' });
          const cfg = ctx.readConfig();
          // Pairing gate: when the operator has paired any senders, the
          // relay must identify an allowlisted senderId.
          const allow = Array.isArray(cfg.pairing) ? cfg.pairing.map((p) => String(p && p.id)) : [];
          if (allow.length > 0) {
            const sender = String(body.senderId || '');
            if (!sender || !allow.includes(sender)) return writeJson(res, 403, { error: 'sender not paired' });
          }
          const provName = body.provider || cfg.provider || 'mock';
          const resolved = resolveProvider(body, provName, cachedByName, logger);
          if (resolved.error) return writeJson(res, 400, { error: resolved.error });
          let acc = '';
          let inboundUsage = null;
          try {
            for await (const chunk of resolved.provider.sendMessage(
              [{ role: 'user', content: text }],
              { apiKey: cfg['api-key'], model: body.model || cfg.model, onUsage: (u) => { inboundUsage = u; } },
            )) acc += chunk;
          } catch (err) {
            const m = statusForProviderError(err);
            return writeJson(res, m.status, { error: err?.message || String(err), code: err?.code || null }, m.headers || {});
          }
          // Feed the running spend total so the cost cap can actually trip
          // on /inbound traffic (mirrors POST /agent / POST /chat).
          if (inboundUsage && cfg.rates) {
            try {
              const c = costFromUsage({ provider: provName, model: body.model || cfg.model, usage: inboundUsage }, cfg.rates);
              if (c) accumulateMetricsFromCost(metrics, inboundUsage, c);
            } catch { /* cost is best-effort; never block a reply on it */ }
          }
          return writeJson(res, 200, { reply: acc, threadId: body.threadId || null });
        }
        case route === 'POST /agent': {
          const breach = checkCostCap(metrics, costCap);
          if (breach) {
            return writeJson(res, 402, {
              error: 'cost cap exceeded',
              currency: breach.currency,
              spent: breach.spent,
              cap: breach.cap,
            });
          }
          const body = await readJson(req);
          const cfg = ctx.readConfig();
          const provName = body.provider || cfg.provider || 'mock';
          const resolved = resolveProvider(body, provName, cachedByName, logger);
          if (resolved.error) return writeJson(res, 400, { error: resolved.error });
          const prov = resolved.provider;
          const prompt = String(body.prompt ?? '').trim();
          if (!prompt) return writeJson(res, 400, { error: 'prompt required' });
          const model = body.model || cfg.model;
          const thinkingBudget = Number(body.thinkingBudget) || 0;

          // Session hydration if sessionId provided.
          const sid = body.sessionId || null;
          const cfgDir = ctx.sessionsDirGetter();
          let messages = sid ? ctx.sessionsMod.loadTurns(sid, cfgDir).map(t => ({ role: t.role, content: t.content })) : [];
          // Skill composition: body.skills can be a comma-separated string
          // ("a,b") or an array (["a","b"]). Compose only when no system
          // message already exists in the message array (so re-runs of
          // the same session don't double-prepend).
          const skillNames = Array.isArray(body.skills)
            ? body.skills
            : (typeof body.skills === 'string' ? body.skills.split(',').map(s => s.trim()).filter(Boolean) : []);
          if (skillNames.length > 0 && !messages.some(m => m.role === 'system')) {
            try {
              const sys = composeSystemPrompt(skillNames, cfgDir);
              if (sys) messages.unshift({ role: 'system', content: sys });
            } catch (err) {
              return writeJson(res, 400, { error: `skill error: ${err?.message || String(err)}` });
            }
          }
          messages.push({ role: 'user', content: prompt });
          if (sid) ctx.sessionsMod.appendTurn(sid, 'user', prompt, cfgDir);

          // body.usage opt-in mirrors POST /chat — provider only does the
          // extra work when the caller asks for it.
          let agentCaptured = null;
          const agentSendOpts = {
            apiKey: cfg['api-key'],
            model,
            thinking: thinkingBudget > 0 ? { enabled: true, budgetTokens: thinkingBudget } : undefined,
            onUsage: body.usage ? (u) => { agentCaptured = u; } : undefined,
          };
          const computeAgentCost = () => {
            if (!body.cost || !agentCaptured || !cfg.rates) return null;
            try {
              const c = costFromUsage(
                { provider: provName, model, usage: agentCaptured },
                cfg.rates,
              );
              if (c) accumulateMetricsFromCost(metrics, agentCaptured, c);
              return c;
            } catch { return null; }
          };

          if (body.stream === true) {
            writeSseHead(res);
            // Forward client disconnect to the provider so we don't keep
            // burning tokens after the consumer has gone away.
            const ac = new AbortController();
            req.on('aborted', () => ac.abort());
            res.on('close', () => { if (!res.writableEnded) ac.abort(); });
            let acc = '';
            try {
              for await (const chunk of prov.sendMessage(messages, { ...agentSendOpts, signal: ac.signal })) {
                if (ac.signal.aborted) break;
                acc += chunk;
                writeSse(res, 'token', { text: chunk });
                // Backpressure: yield so the caller can read each frame.
                await new Promise(r => setImmediate(r));
              }
              if (sid && !ac.signal.aborted) ctx.sessionsMod.appendTurn(sid, 'assistant', acc, cfgDir);
              if (!ac.signal.aborted) {
                if (agentCaptured) writeSse(res, 'usage', agentCaptured);
                const cost = computeAgentCost();
                if (cost) writeSse(res, 'cost', cost);
                writeSse(res, 'done', { ok: true });
              }
              return res.end();
            } catch (err) {
              if (err?.code === 'ABORT' || ac.signal.aborted) {
                // Client gave up — partial assistant turn is discarded.
                return res.end();
              }
              writeSse(res, 'error', { message: err?.message || String(err) });
              return res.end();
            }
          }

          // Non-streaming: collect then return once. Reuse agentSendOpts
          // (carrying the optional onUsage capture) so usage lands in the
          // response when body.usage was set.
          let acc = '';
          try {
            for await (const chunk of prov.sendMessage(messages, agentSendOpts)) acc += chunk;
            if (sid) ctx.sessionsMod.appendTurn(sid, 'assistant', acc, cfgDir);
            const cost = computeAgentCost();
            const out = { reply: acc };
            if (agentCaptured) out.usage = agentCaptured;
            if (cost) out.cost = cost;
            return writeJson(res, 200, out);
          } catch (err) {
            const m = statusForProviderError(err);
            return writeJson(res, m.status, {
              error: err?.message || String(err),
              code: err?.code || null,
              ...(err?.retryAfterMs ? { retryAfterMs: err.retryAfterMs } : {}),
            }, m.headers || {});
          }
        }
        // ──── Multi-agent dashboard surface (Phase 15) ────────────────
        // Routes share the same JSON-only shape the rest of the daemon
        // uses. The on-disk state is owned by agents.mjs / teams.mjs /
        // tasks.mjs; we don't touch the files directly here so the CLI
        // and the dashboard stay coherent.
        case route === 'GET /agents': {
          const mod = await import('./agents.mjs');
          return writeJson(res, 200, mod.listAgents());
        }
        case route === 'POST /agents': {
          const mod = await import('./agents.mjs');
          let body;
          try { body = await readJson(req); }
          catch (e) { return writeJson(res, 400, { error: e?.message || String(e) }); }
          try { return writeJson(res, 200, mod.registerAgent(body)); }
          catch (err) {
            const code = err?.code === 'AGENT_EXISTS' ? 409 : 400;
            return writeJson(res, code, { error: err?.message || String(err), code: err?.code });
          }
        }
        case req.method === 'GET' && /^\/agents\/([^/]+)$/.test(url.pathname): {
          const name = url.pathname.split('/').pop();
          const mod = await import('./agents.mjs');
          const a = mod.getAgent(name);
          if (!a) return writeJson(res, 404, { error: `no agent "${name}"` });
          return writeJson(res, 200, a);
        }
        case req.method === 'PATCH' && /^\/agents\/([^/]+)$/.test(url.pathname): {
          const name = url.pathname.split('/').pop();
          const mod = await import('./agents.mjs');
          let body;
          try { body = await readJson(req); }
          catch (e) { return writeJson(res, 400, { error: e?.message || String(e) }); }
          try { return writeJson(res, 200, mod.patchAgent(name, body)); }
          catch (err) {
            const code = err?.code === 'AGENT_NO_AGENT' ? 404 : 400;
            return writeJson(res, code, { error: err?.message || String(err), code: err?.code });
          }
        }
        case req.method === 'DELETE' && /^\/agents\/([^/]+)$/.test(url.pathname): {
          const name = url.pathname.split('/').pop();
          const mod = await import('./agents.mjs');
          try { return writeJson(res, 200, mod.removeAgent(name)); }
          catch (err) {
            return writeJson(res, 404, { error: err?.message || String(err), code: err?.code });
          }
        }
        case req.method === 'GET' && /^\/agents\/([^/]+)\/memory$/.test(url.pathname): {
          // M13 — 404 when the agent is not registered. The historical
          // behaviour silently returned an empty body, which made
          // typos indistinguishable from "no memory yet" and let the
          // dashboard render a stub for a non-existent agent.
          const name = url.pathname.match(/^\/agents\/([^/]+)\/memory$/)[1];
          const agentsMod = await import('./agents.mjs');
          if (!agentsMod.getAgent(name)) {
            return writeJson(res, 404, { error: `no agent "${name}"`, name });
          }
          const memMod = await import('./mas/agent_memory.mjs');
          const text = memMod.readMemory(name);
          res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-cache' });
          return res.end(text);
        }
        case req.method === 'PUT' && /^\/agents\/([^/]+)\/memory$/.test(url.pathname): {
          // M13 — 404 when the agent is not registered. Without this
          // check, writeRaw happily created memory.md for a misspelled
          // agent name and the orphan file lived forever.
          const name = url.pathname.match(/^\/agents\/([^/]+)\/memory$/)[1];
          const agentsMod = await import('./agents.mjs');
          if (!agentsMod.getAgent(name)) {
            return writeJson(res, 404, { error: `no agent "${name}"`, name });
          }
          const memMod = await import('./mas/agent_memory.mjs');
          // Read raw text body — content-type defaults to text/markdown
          // but JSON {"text": "..."} is also accepted for tooling that
          // prefers structured bodies.
          let body = '';
          await new Promise((resolve) => {
            req.on('data', (c) => { body += c.toString(); });
            req.on('end', resolve);
          });
          let text = body;
          if (req.headers['content-type']?.includes('application/json')) {
            try { text = (JSON.parse(body || '{}').text) || ''; } catch { /* leave raw */ }
          }
          try {
            const p = memMod.writeRaw(name, text);
            return writeJson(res, 200, { path: p, bytes: Buffer.byteLength(text, 'utf8') });
          } catch (err) {
            return writeJson(res, 400, { error: err?.message || String(err), code: err?.code });
          }
        }
        case req.method === 'DELETE' && /^\/agents\/([^/]+)\/memory$/.test(url.pathname): {
          const name = url.pathname.match(/^\/agents\/([^/]+)\/memory$/)[1];
          const agentsMod = await import('./agents.mjs');
          if (!agentsMod.getAgent(name)) {
            return writeJson(res, 404, { error: `no agent "${name}"`, name });
          }
          const memMod = await import('./mas/agent_memory.mjs');
          const removed = memMod.clear(name);
          return writeJson(res, 200, { name, cleared: removed });
        }

        case route === 'GET /teams': {
          const mod = await import('./teams.mjs');
          return writeJson(res, 200, mod.listTeams());
        }
        case route === 'POST /teams': {
          const mod = await import('./teams.mjs');
          let body;
          try { body = await readJson(req); }
          catch (e) { return writeJson(res, 400, { error: e?.message || String(e) }); }
          try { return writeJson(res, 200, mod.registerTeam(body)); }
          catch (err) {
            const code = err?.code === 'TEAM_EXISTS' ? 409 : 400;
            return writeJson(res, code, { error: err?.message || String(err), code: err?.code });
          }
        }
        case req.method === 'GET' && /^\/teams\/([^/]+)$/.test(url.pathname): {
          const name = url.pathname.split('/').pop();
          const mod = await import('./teams.mjs');
          const t = mod.getTeam(name);
          if (!t) return writeJson(res, 404, { error: `no team "${name}"` });
          return writeJson(res, 200, t);
        }
        case req.method === 'PATCH' && /^\/teams\/([^/]+)$/.test(url.pathname): {
          const name = url.pathname.split('/').pop();
          const mod = await import('./teams.mjs');
          let body;
          try { body = await readJson(req); }
          catch (e) { return writeJson(res, 400, { error: e?.message || String(e) }); }
          try { return writeJson(res, 200, mod.patchTeam(name, body)); }
          catch (err) {
            const code = err?.code === 'TEAM_NO_TEAM' ? 404 : 400;
            return writeJson(res, code, { error: err?.message || String(err), code: err?.code });
          }
        }
        case req.method === 'DELETE' && /^\/teams\/([^/]+)$/.test(url.pathname): {
          const name = url.pathname.split('/').pop();
          const mod = await import('./teams.mjs');
          try { return writeJson(res, 200, mod.removeTeam(name)); }
          catch (err) {
            return writeJson(res, 404, { error: err?.message || String(err), code: err?.code });
          }
        }

        case route === 'GET /tasks': {
          const mod = await import('./tasks.mjs');
          return writeJson(res, 200, mod.listTasks());
        }
        case req.method === 'GET' && /^\/tasks\/([^/]+)\/transcript$/.test(url.pathname): {
          const m = url.pathname.match(/^\/tasks\/([^/]+)\/transcript$/);
          const id = m[1];
          const mod = await import('./tasks.mjs');
          const t = mod.getTask(id);
          if (!t) return writeJson(res, 404, { error: `no task "${id}"` });
          const fmt = String(url.searchParams.get('format') || 'text');
          if (fmt === 'json') return writeJson(res, 200, t);
          const body = mod.formatTranscript(t, fmt);
          const mime = fmt === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8';
          res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache' });
          return res.end(body);
        }
        case req.method === 'GET' && /^\/tasks\/([^/]+)$/.test(url.pathname): {
          const id = url.pathname.split('/').pop();
          const mod = await import('./tasks.mjs');
          const t = mod.getTask(id);
          if (!t) return writeJson(res, 404, { error: `no task "${id}"` });
          return writeJson(res, 200, t);
        }
        case req.method === 'DELETE' && /^\/tasks\/([^/]+)$/.test(url.pathname): {
          const id = url.pathname.split('/').pop();
          const mod = await import('./tasks.mjs');
          try { return writeJson(res, 200, mod.removeTask(id)); }
          catch (err) {
            return writeJson(res, 404, { error: err?.message || String(err), code: err?.code });
          }
        }
        case req.method === 'POST' && /^\/tasks\/([^/]+)\/(done|abandon)$/.test(url.pathname): {
          const m = url.pathname.match(/^\/tasks\/([^/]+)\/(done|abandon)$/);
          const id = m[1];
          const action = m[2];
          const mod = await import('./tasks.mjs');
          try {
            const next = mod.patchTask(id, { status: action === 'done' ? 'done' : 'abandoned' });
            return writeJson(res, 200, next);
          } catch (err) {
            return writeJson(res, 404, { error: err?.message || String(err), code: err?.code });
          }
        }

        // ── v5 dashboard surfaces ────────────────────────────────────
        case route === 'GET /trainer/status': {
          // Reads cfg.trainer.{provider, model, schedule, budget, recipe}
          // and reports last-run state from <configDir>/trainer-state.json
          // if present. No standalone trainer module yet; this is a thin
          // config-surface endpoint the dashboard reads at refresh.
          const cfg = ctx.readConfig();
          const t = (cfg.trainer && typeof cfg.trainer === 'object') ? cfg.trainer : {};
          let lastRunAt = null, callsToday = null;
          try {
            const statePath = nodePath.join(gwConfigDir || skillsDefaultConfigDir(), 'trainer-state.json');
            if (fs.existsSync(statePath)) {
              const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
              lastRunAt = st?.lastRunAt || null;
              // callsToday: count entries whose ts is within the current
              // UTC day. State writer is the (future) trainer; reader
              // tolerates absence.
              const today = new Date().toISOString().slice(0, 10);
              if (Array.isArray(st?.calls)) {
                callsToday = st.calls.filter((c) => String(c.ts || '').startsWith(today)).length;
              } else if (typeof st?.callsToday === 'number') {
                callsToday = st.callsToday;
              }
            }
          } catch { /* missing/corrupt state → null */ }
          return writeJson(res, 200, {
            provider: t.provider || null,
            model: t.model || null,
            schedule: t.schedule || null,
            budget: t.budget != null ? Number(t.budget) : null,
            recipe: t.recipe || null,
            lastRunAt,
            callsToday,
          });
        }
        case route === 'POST /trainer/sync': {
          // Stub: a real trainer scheduler lands in v5.1. For now we
          // record the trigger in trainer-state.json so the dashboard's
          // "Sync now" button has feedback, and a future trainer reads
          // the queue. Surfacing it here keeps the API stable across the
          // transition.
          try {
            const dir = gwConfigDir || skillsDefaultConfigDir();
            fs.mkdirSync(dir, { recursive: true });
            const statePath = nodePath.join(dir, 'trainer-state.json');
            let st = {};
            if (fs.existsSync(statePath)) {
              try { st = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { st = {}; }
            }
            st.lastSyncRequestAt = new Date().toISOString();
            st.syncQueued = (st.syncQueued || 0) + 1;
            fs.writeFileSync(statePath, JSON.stringify(st, null, 2));
            return writeJson(res, 200, { ok: true, message: 'sync queued', queued: st.syncQueued });
          } catch (e) {
            return writeJson(res, 500, { error: e?.message || String(e) });
          }
        }
        case route === 'GET /recall': {
          // GET /recall?q=...&scope=sessions|skills|trajectories|memories|all&k=N
          const q = url.searchParams.get('q');
          if (!q) return writeJson(res, 400, { error: 'missing q query parameter' });
          const scopeParam = url.searchParams.get('scope') || 'all';
          const scope = scopeParam === 'all'
            ? ['sessions', 'skills', 'trajectories', 'memories']
            : scopeParam.split(',').map((x) => x.trim()).filter(Boolean);
          const kParam = url.searchParams.get('k');
          const k = kParam ? Math.max(1, Math.min(50, parseInt(kParam, 10) || 10)) : 10;
          try {
            const r = indexDb.recall(q, { configDir: gwConfigDir, scope, k });
            return writeJson(res, 200, r);
          } catch (e) {
            return writeJson(res, 500, { error: e?.message || String(e) });
          }
        }
        case route === 'GET /sandbox': {
          const cfg = ctx.readConfig();
          const sb = (cfg.sandbox && typeof cfg.sandbox === 'object') ? cfg.sandbox : {};
          const active = sb.default || 'local';
          const profiles = sandboxListBackends().map((name) => {
            const section = sb[name];
            const configured = !!section && typeof section === 'object';
            let summary = '';
            if (configured) {
              if (name === 'docker' && section.image) summary = `image: ${section.image}`;
              else if (name === 'ssh' && section.host) summary = `host: ${section.host}`;
              else if (name === 'singularity' && section.image) summary = `image: ${section.image}`;
              else if (name === 'modal' && section.app) summary = `app: ${section.app}`;
              else if (name === 'daytona' && section.workspace) summary = `workspace: ${section.workspace}`;
              else if (name === 'local' && section.confiner) summary = `confiner: ${section.confiner}`;
            }
            return { name, configured, summary };
          });
          return writeJson(res, 200, { profiles, active });
        }
        case req.method === 'POST' && /^\/sandbox\/([^/]+)\/test$/.test(url.pathname): {
          // POST /sandbox/<name>/test — opens a session against the named
          // backend, runs `echo hello`, returns { ok, durationMs, stdout }.
          const name = url.pathname.match(/^\/sandbox\/([^/]+)\/test$/)[1];
          try {
            const sandboxMod = await import('./sandbox/index.mjs');
            const cfg = ctx.readConfig();
            // Synthesise a one-off cfg.sandbox.default override so we can
            // test a backend without mutating the user's persisted choice.
            const probeCfg = {
              ...cfg,
              sandbox: { ...(cfg.sandbox || {}), default: name },
            };
            const t0 = Date.now();
            const box = sandboxMod.resolveSandbox(probeCfg, null);
            const sess = await box.open();
            let result;
            try {
              result = await sess.exec(['echo', 'hello'], { stdio: 'pipe' });
            } finally {
              try { await sess.close(); } catch { /* ignore */ }
            }
            const durationMs = Date.now() - t0;
            const ok = result.code === 0;
            return writeJson(res, ok ? 200 : 500, {
              ok,
              durationMs,
              code: result.code,
              stdout: String(result.stdout || '').slice(0, 200),
              stderr: String(result.stderr || '').slice(0, 200),
            });
          } catch (e) {
            return writeJson(res, 500, { ok: false, error: e?.message || String(e), code: e?.code });
          }
        }
        case route === 'POST /sandbox/use': {
          if (typeof ctx.writeConfig !== 'function') {
            return writeJson(res, 405, { error: 'mutation disabled' });
          }
          let body;
          try { body = await readJson(req); }
          catch (e) { return writeJson(res, 400, { error: e?.message || String(e) }); }
          const name = body && String(body.name || '').trim();
          if (!name) return writeJson(res, 400, { error: 'name is required' });
          if (!sandboxListBackends().includes(name)) {
            return writeJson(res, 400, { error: `unknown sandbox backend: ${name}` });
          }
          const cfg = ctx.readConfig();
          cfg.sandbox = { ...(cfg.sandbox || {}), default: name };
          ctx.writeConfig(cfg);
          return writeJson(res, 200, { ok: true, active: name });
        }
        case route === 'GET /channels': {
          // Aggregate cfg.channels.<name> + any channel-specific runtime
          // state we expose. Keeps the dashboard from having to know
          // each channel module's shape.
          const cfg = ctx.readConfig();
          const chCfg = (cfg.channels && typeof cfg.channels === 'object') ? cfg.channels : {};
          // Known built-in channel names (matches channels/ + channels-*).
          const KNOWN = ['slack', 'matrix', 'telegram', 'discord', 'email', 'signal', 'whatsapp', 'voice', 'http'];
          const out = [];
          for (const name of KNOWN) {
            const sec = chCfg[name];
            if (!sec && !cfg[`${name}-bot-token`] && !cfg[`${name}-token`]) continue;
            out.push({
              name,
              enabled: !!(sec && (sec.enabled !== false)),
              lastInboundAt: sec?.lastInboundAt || null,
              boundAgent: sec?.agent || sec?.boundAgent || null,
            });
          }
          // Surface any additional configured channels we didn't enumerate.
          for (const name of Object.keys(chCfg)) {
            if (KNOWN.includes(name)) continue;
            const sec = chCfg[name] || {};
            out.push({
              name,
              enabled: sec.enabled !== false,
              lastInboundAt: sec.lastInboundAt || null,
              boundAgent: sec.agent || sec.boundAgent || null,
            });
          }
          return writeJson(res, 200, { channels: out });
        }
        case route === 'POST /index/rebuild': {
          try {
            indexDb.rebuild(gwConfigDir);
            ctx.indexLastRebuiltAt = new Date().toISOString();
            return writeJson(res, 200, { ok: true, rebuiltAt: ctx.indexLastRebuiltAt });
          } catch (e) {
            return writeJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        }

        default:
          return writeJson(res, 404, { error: 'not found', route });
      } /* eslint-disable-line no-fallthrough */
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
