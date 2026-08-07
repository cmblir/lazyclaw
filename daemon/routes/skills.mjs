// Daemon route handlers (skills), extracted verbatim from makeHandler (D5).
// Each handler takes the per-request dispatch context `c` and returns the
// HTTP response. Bodies are unchanged; only the dispatch wrapper is new.
import { fs, nodePath, PROVIDERS, PROVIDER_INFO, maskApiKey, costFromUsage, RATE_CARD_SHAPE, composeSystemPrompt, listSkills, loadSkill, skillPath, installSkill, removeSkill, parseFrontmatter, skillsDefaultConfigDir, indexDb, skillSynth, sandboxListBackends, summarizeState, listWorkflowSessions, loadWorkflowState, aggregateNodeStats, validateConfig, validateRates, fileExists, readJson, readTextBody, writeJson, writeSseHead, writeSse, statusForProviderError, checkCostCap, accumulateMetricsFromCost, resolveProvider } from './_deps.mjs';

export async function skillsList(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

export async function skillsSuggestions(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          // Ring buffer of nudge.suggest_skill events. Dashboard polls this
          // since the SSE bus is deferred to v5.1.
          return writeJson(res, 200, { suggestions: nudgeSuggestionsRing.slice(0, 20) });
}

export async function skillsSynth(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

export async function skillsSearch(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          // Mirror of `pompos skills search`. ?q=<query> required;
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

export async function skillGet(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

export async function skillPut(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

export async function skillDelete(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

