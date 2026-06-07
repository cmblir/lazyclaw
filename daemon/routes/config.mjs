// Daemon route handlers (config), extracted verbatim from makeHandler (D5).
// Each handler takes the per-request dispatch context `c` and returns the
// HTTP response. Bodies are unchanged; only the dispatch wrapper is new.
import { fs, nodePath, PROVIDERS, PROVIDER_INFO, maskApiKey, costFromUsage, RATE_CARD_SHAPE, composeSystemPrompt, listSkills, loadSkill, skillPath, installSkill, removeSkill, parseFrontmatter, skillsDefaultConfigDir, indexDb, skillSynth, sandboxListBackends, summarizeState, listWorkflowSessions, loadWorkflowState, aggregateNodeStats, validateConfig, validateRates, fileExists, readJson, readTextBody, writeJson, writeSseHead, writeSse, statusForProviderError, checkCostCap, accumulateMetricsFromCost, resolveProvider } from './_deps.mjs';

export async function configValidate(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

export async function configGet(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          // Mirror of `lazyclaw config list`. Returns every stored key
          // with the api-key value masked — lets a dashboard or script
          // inspect the active configuration without shelling to the CLI.
          const cfg = ctx.readConfig();
          const safe = { ...cfg };
          if (safe['api-key']) safe['api-key'] = maskApiKey(safe['api-key']);
          return writeJson(res, 200, safe);
}

export async function configKeyGet(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

export async function configKeyPut(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

export async function configKeyDelete(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

