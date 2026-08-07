// Daemon route handlers (providers), extracted verbatim from makeHandler (D5).
// Each handler takes the per-request dispatch context `c` and returns the
// HTTP response. Bodies are unchanged; only the dispatch wrapper is new.
import { fs, nodePath, PROVIDERS, PROVIDER_INFO, maskApiKey, resolveModelsForProvider, costFromUsage, RATE_CARD_SHAPE, composeSystemPrompt, listSkills, loadSkill, skillPath, installSkill, removeSkill, parseFrontmatter, skillsDefaultConfigDir, indexDb, skillSynth, sandboxListBackends, summarizeState, listWorkflowSessions, loadWorkflowState, aggregateNodeStats, validateConfig, validateRates, fileExists, readJson, readTextBody, writeJson, writeSseHead, writeSse, statusForProviderError, checkCostCap, accumulateMetricsFromCost, resolveProvider } from './_deps.mjs';
import { _resolveAuthKey } from '../../lib/config.mjs';

export async function providersList(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          // ?filter=<substr>&limit=<N> mirror v3.33+ list flags.
          // The dashboard reads `custom` / `builtinOpenAICompat` / `endpoint`
          // / `docs` to render the right pills + tooltips; CLI callers only
          // need `name` / `requiresApiKey` / `suggestedModels` and ignore
          // the extras (additive change, no migration).
          // suggestedModels/modelsSource resolve through the live model-list
          // cache (never blocks — see daemon/lib/model_cache.mjs): a fresh
          // live fetch ('live'), else the generated file or the hand-written
          // registry list ('builtin'), so the dashboard can tell a fetched
          // list from a frozen one.
          let out = Object.keys(PROVIDERS).map(name => {
            const meta = PROVIDER_INFO[name] || { name };
            const { models: suggestedModels, source: modelsSource } = resolveModelsForProvider(name, { cache: c.modelCache });
            return {
              name,
              requiresApiKey: !!meta.requiresApiKey,
              defaultModel: meta.defaultModel || null,
              suggestedModels,
              modelsSource,
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

export async function providerGet(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          // GET /providers/<name> — full per-provider metadata
          // (mirrors CLI `pompos providers info <name>`).
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

export async function providersTest(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          // Mirror of CLI v3.55 `pompos providers test` (no name).
          // A dashboard's "key validity" badge calls this once and
          // gets a per-provider verdict in one round trip. HTTP
          // status mirrors CLI exit code:
          //   200 — every provider returned a non-empty reply
          //   503 — at least one provider failed (Service Unavailable;
          //         "the system is partially unhealthy")
          // 503 is the right code because a dashboard observing it
          // can render a yellow status without parsing the body.
          const cfg = ctx.readConfig();
          const sharedPrompt = url.searchParams.get('prompt') || 'ping';
          // Per-provider timeout so one unreachable provider (a keyless
          // claude-cli subprocess that never logs in, a dead network endpoint)
          // can't hang the whole all-providers probe — without it the route
          // blocks until every sendMessage settles. Override with ?timeoutMs=;
          // floor 1000, default 8000.
          const _tm = parseInt(url.searchParams.get('timeoutMs') || '', 10);
          const perTimeoutMs = Number.isFinite(_tm) && _tm >= 1000 ? _tm : 8000;
          const tAll = Date.now();
          const results = await Promise.all(
            Object.entries(PROVIDERS).map(async ([pid, provider]) => {
              const meta = PROVIDER_INFO[pid] || {};
              const model = url.searchParams.get('model') || cfg.model || meta.defaultModel || 'unknown';
              // Each provider resolves its OWN key (env / authProfiles / custom),
              // falling back to legacy cfg['api-key']; a shared key falsely
              // failed every provider not stored there.
              const apiKey = _resolveAuthKey(cfg, pid) || cfg['api-key'] || '';
              const t0 = Date.now();
              const ac = new AbortController();
              let timer = null;
              try {
                const consume = (async () => {
                  let reply = '';
                  const stream = provider.sendMessage([{ role: 'user', content: sharedPrompt }], { apiKey, model, signal: ac.signal });
                  for await (const chunk of stream) {
                    if (typeof chunk === 'string') reply += chunk;
                  }
                  return reply;
                })();
                const timeout = new Promise((_, reject) => {
                  timer = setTimeout(() => { try { ac.abort(); } catch { /* best-effort */ } reject(new Error(`timed out after ${perTimeoutMs}ms`)); }, perTimeoutMs);
                });
                const reply = await Promise.race([consume, timeout]);
                return {
                  name: pid, ok: reply.length > 0, model,
                  durationMs: Date.now() - t0,
                  replyLength: reply.length,
                };
              } catch (err) {
                try { ac.abort(); } catch { /* best-effort */ }
                const timedOut = /timed out after/.test(err?.message || '');
                return {
                  name: pid, ok: false, model,
                  durationMs: Date.now() - t0,
                  error: err?.message || String(err),
                  code: timedOut ? 'TIMEOUT' : (err?.code || null),
                };
              } finally {
                if (timer) clearTimeout(timer);
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

export async function providerTest(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          // GET /providers/<name>/test — single-provider 1-token reachability
          // probe. Same shape as one entry of GET /providers/test, but the
          // endpoint stops on the first failure and exposes the reply body
          // (truncated) so the dashboard can show a real signal of life.
          const name = providerTestMatch[1];
          const provider = PROVIDERS[name];
          if (!provider) return writeJson(res, 404, { error: `unknown provider: ${name}` });
          const cfg = ctx.readConfig();
          const apiKey = _resolveAuthKey(cfg, name) || cfg['api-key'] || '';
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

export async function providersCreate(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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
          const reg = await import('../../providers/registry.mjs');
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

export async function providerDelete(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

