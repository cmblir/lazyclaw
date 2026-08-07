// Daemon route handlers (sessions), extracted verbatim from makeHandler (D5).
// Each handler takes the per-request dispatch context `c` and returns the
// HTTP response. Bodies are unchanged; only the dispatch wrapper is new.
import { fs, nodePath, PROVIDERS, PROVIDER_INFO, maskApiKey, costFromUsage, RATE_CARD_SHAPE, composeSystemPrompt, listSkills, loadSkill, skillPath, installSkill, removeSkill, parseFrontmatter, skillsDefaultConfigDir, indexDb, skillSynth, sandboxListBackends, summarizeState, listWorkflowSessions, loadWorkflowState, aggregateNodeStats, validateConfig, validateRates, fileExists, readJson, readTextBody, writeJson, writeSseHead, writeSse, statusForProviderError, checkCostCap, accumulateMetricsFromCost, resolveProvider } from './_deps.mjs';

export async function sessionsList(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

export async function sessionsSearch(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          // Mirror of `pompos sessions search <query> [--regex]`.
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

export async function sessionExport(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          // GET /sessions/<id>/export?format=md|json|text — same body
          // the CLI's `pompos sessions export <id> --format ...`
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

export async function sessionGet(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

export async function sessionDelete(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

