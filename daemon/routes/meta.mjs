// Daemon route handlers (meta), extracted verbatim from makeHandler (D5).
// Each handler takes the per-request dispatch context `c` and returns the
// HTTP response. Bodies are unchanged; only the dispatch wrapper is new.
import { fs, nodePath, PROVIDERS, PROVIDER_INFO, maskApiKey, costFromUsage, RATE_CARD_SHAPE, composeSystemPrompt, listSkills, loadSkill, skillPath, installSkill, removeSkill, parseFrontmatter, skillsDefaultConfigDir, indexDb, skillSynth, sandboxListBackends, summarizeState, listWorkflowSessions, loadWorkflowState, aggregateNodeStats, validateConfig, validateRates, fileExists, readJson, readTextBody, writeJson, writeSseHead, writeSse, statusForProviderError, checkCostCap, accumulateMetricsFromCost, resolveProvider } from './_deps.mjs';

export async function dashboard(c) {
  const { res } = c;
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
            const htmlPath = path.join(here, '..', '..', 'web', 'dashboard.html');
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

export async function version(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          return writeJson(res, 200, { version: ctx.version(), nodeVersion: process.version, platform: `${process.platform}-${process.arch}` });
}

export async function health(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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
}

export async function metrics(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

export async function status(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

export async function doctor(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

