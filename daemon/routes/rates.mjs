// Daemon route handlers (rates), extracted verbatim from makeHandler (D5).
// Each handler takes the per-request dispatch context `c` and returns the
// HTTP response. Bodies are unchanged; only the dispatch wrapper is new.
import { fs, nodePath, PROVIDERS, PROVIDER_INFO, maskApiKey, costFromUsage, RATE_CARD_SHAPE, composeSystemPrompt, listSkills, loadSkill, skillPath, installSkill, removeSkill, parseFrontmatter, skillsDefaultConfigDir, indexDb, skillSynth, sandboxListBackends, summarizeState, listWorkflowSessions, loadWorkflowState, aggregateNodeStats, validateConfig, validateRates, fileExists, readJson, readTextBody, writeJson, writeSseHead, writeSse, statusForProviderError, checkCostCap, accumulateMetricsFromCost, resolveProvider } from './_deps.mjs';

export async function ratesList(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

export async function ratesValidate(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

export async function ratesShape(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          // Mirror of `lazyclaw rates shape`. Returns the zero-filled
          // reference rate-card template so a dashboard config panel
          // or a script that scaffolds a new card can get the required
          // fields without shelling to the CLI.
          return writeJson(res, 200, RATE_CARD_SHAPE);
}

export async function ratePut(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

export async function rateDelete(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

