// Daemon route handlers (ops), extracted verbatim from makeHandler (D5).
// Each handler takes the per-request dispatch context `c` and returns the
// HTTP response. Bodies are unchanged; only the dispatch wrapper is new.
import { fs, nodePath, PROVIDERS, PROVIDER_INFO, maskApiKey, costFromUsage, RATE_CARD_SHAPE, composeSystemPrompt, listSkills, loadSkill, skillPath, installSkill, removeSkill, parseFrontmatter, skillsDefaultConfigDir, indexDb, skillSynth, sandboxListBackends, summarizeState, listWorkflowSessions, loadWorkflowState, aggregateNodeStats, validateConfig, validateRates, fileExists, readJson, readTextBody, writeJson, writeSseHead, writeSse, statusForProviderError, checkCostCap, accumulateMetricsFromCost, resolveProvider } from './_deps.mjs';

export async function trainerStatus(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

export async function recall(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

export async function sandboxList(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

export async function sandboxTest(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          // POST /sandbox/<name>/test — opens a session against the named
          // backend, runs `echo hello`, returns { ok, durationMs, stdout }.
          const name = url.pathname.match(/^\/sandbox\/([^/]+)\/test$/)[1];
          try {
            const sandboxMod = await import('../../sandbox/index.mjs');
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

export async function sandboxUse(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

export async function channels(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

export async function indexRebuild(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          try {
            // reindexAll, not rebuild: a bare rebuild zeroes the FTS index and
            // never repopulates, so this route used to silently wipe recall.
            indexDb.reindexAll(gwConfigDir);
            ctx.indexLastRebuiltAt = new Date().toISOString();
            return writeJson(res, 200, { ok: true, rebuiltAt: ctx.indexLastRebuiltAt });
          } catch (e) {
            return writeJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
}

