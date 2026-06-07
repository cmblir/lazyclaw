// Daemon route handlers (workflows), extracted verbatim from makeHandler (D5).
// Each handler takes the per-request dispatch context `c` and returns the
// HTTP response. Bodies are unchanged; only the dispatch wrapper is new.
import { fs, nodePath, PROVIDERS, PROVIDER_INFO, maskApiKey, costFromUsage, RATE_CARD_SHAPE, composeSystemPrompt, listSkills, loadSkill, skillPath, installSkill, removeSkill, parseFrontmatter, skillsDefaultConfigDir, indexDb, skillSynth, sandboxListBackends, summarizeState, listWorkflowSessions, loadWorkflowState, aggregateNodeStats, validateConfig, validateRates, fileExists, readJson, readTextBody, writeJson, writeSseHead, writeSse, statusForProviderError, checkCostCap, accumulateMetricsFromCost, resolveProvider } from './_deps.mjs';

export async function workflowsAggregate(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

export async function workflowsList(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

export async function workflowGet(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

export async function workflowDelete(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

