// Daemon route handlers (registry), extracted verbatim from makeHandler (D5).
// Each handler takes the per-request dispatch context `c` and returns the
// HTTP response. Bodies are unchanged; only the dispatch wrapper is new.
import { fs, nodePath, PROVIDERS, PROVIDER_INFO, maskApiKey, costFromUsage, RATE_CARD_SHAPE, composeSystemPrompt, listSkills, loadSkill, skillPath, installSkill, removeSkill, parseFrontmatter, skillsDefaultConfigDir, indexDb, skillSynth, sandboxListBackends, summarizeState, listWorkflowSessions, loadWorkflowState, aggregateNodeStats, validateConfig, validateRates, fileExists, readJson, readTextBody, writeJson, writeSseHead, writeSse, statusForProviderError, checkCostCap, accumulateMetricsFromCost, resolveProvider } from './_deps.mjs';

export async function agentsList(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          const mod = await import('../../agents.mjs');
          return writeJson(res, 200, mod.listAgents());
}

export async function agentsCreate(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          const mod = await import('../../agents.mjs');
          let body;
          try { body = await readJson(req); }
          catch (e) { return writeJson(res, 400, { error: e?.message || String(e) }); }
          try { return writeJson(res, 200, mod.registerAgent(body)); }
          catch (err) {
            const code = err?.code === 'AGENT_EXISTS' ? 409 : 400;
            return writeJson(res, code, { error: err?.message || String(err), code: err?.code });
          }
}

export async function agentGet(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          const name = url.pathname.split('/').pop();
          const mod = await import('../../agents.mjs');
          const a = mod.getAgent(name);
          if (!a) return writeJson(res, 404, { error: `no agent "${name}"` });
          return writeJson(res, 200, a);
}

export async function agentPatch(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          const name = url.pathname.split('/').pop();
          const mod = await import('../../agents.mjs');
          let body;
          try { body = await readJson(req); }
          catch (e) { return writeJson(res, 400, { error: e?.message || String(e) }); }
          try { return writeJson(res, 200, mod.patchAgent(name, body)); }
          catch (err) {
            const code = err?.code === 'AGENT_NO_AGENT' ? 404 : 400;
            return writeJson(res, code, { error: err?.message || String(err), code: err?.code });
          }
}

export async function agentDelete(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          const name = url.pathname.split('/').pop();
          const mod = await import('../../agents.mjs');
          try { return writeJson(res, 200, mod.removeAgent(name)); }
          catch (err) {
            return writeJson(res, 404, { error: err?.message || String(err), code: err?.code });
          }
}

export async function agentMemoryGet(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          // M13 — 404 when the agent is not registered. The historical
          // behaviour silently returned an empty body, which made
          // typos indistinguishable from "no memory yet" and let the
          // dashboard render a stub for a non-existent agent.
          const name = url.pathname.match(/^\/agents\/([^/]+)\/memory$/)[1];
          const agentsMod = await import('../../agents.mjs');
          if (!agentsMod.getAgent(name)) {
            return writeJson(res, 404, { error: `no agent "${name}"`, name });
          }
          const memMod = await import('../../mas/agent_memory.mjs');
          const text = memMod.readMemory(name);
          res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-cache' });
          return res.end(text);
}

export async function agentMemoryPut(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          // M13 — 404 when the agent is not registered. Without this
          // check, writeRaw happily created memory.md for a misspelled
          // agent name and the orphan file lived forever.
          const name = url.pathname.match(/^\/agents\/([^/]+)\/memory$/)[1];
          const agentsMod = await import('../../agents.mjs');
          if (!agentsMod.getAgent(name)) {
            return writeJson(res, 404, { error: `no agent "${name}"`, name });
          }
          const memMod = await import('../../mas/agent_memory.mjs');
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

export async function agentMemoryDelete(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          const name = url.pathname.match(/^\/agents\/([^/]+)\/memory$/)[1];
          const agentsMod = await import('../../agents.mjs');
          if (!agentsMod.getAgent(name)) {
            return writeJson(res, 404, { error: `no agent "${name}"`, name });
          }
          const memMod = await import('../../mas/agent_memory.mjs');
          const removed = memMod.clear(name);
          return writeJson(res, 200, { name, cleared: removed });
}

export async function teamsList(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          const mod = await import('../../teams.mjs');
          return writeJson(res, 200, mod.listTeams());
}

export async function teamsCreate(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          const mod = await import('../../teams.mjs');
          let body;
          try { body = await readJson(req); }
          catch (e) { return writeJson(res, 400, { error: e?.message || String(e) }); }
          try { return writeJson(res, 200, mod.registerTeam(body)); }
          catch (err) {
            const code = err?.code === 'TEAM_EXISTS' ? 409 : 400;
            return writeJson(res, code, { error: err?.message || String(err), code: err?.code });
          }
}

export async function teamGet(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          const name = url.pathname.split('/').pop();
          const mod = await import('../../teams.mjs');
          const t = mod.getTeam(name);
          if (!t) return writeJson(res, 404, { error: `no team "${name}"` });
          return writeJson(res, 200, t);
}

export async function teamPatch(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          const name = url.pathname.split('/').pop();
          const mod = await import('../../teams.mjs');
          let body;
          try { body = await readJson(req); }
          catch (e) { return writeJson(res, 400, { error: e?.message || String(e) }); }
          try { return writeJson(res, 200, mod.patchTeam(name, body)); }
          catch (err) {
            const code = err?.code === 'TEAM_NO_TEAM' ? 404 : 400;
            return writeJson(res, code, { error: err?.message || String(err), code: err?.code });
          }
}

export async function teamDelete(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          const name = url.pathname.split('/').pop();
          const mod = await import('../../teams.mjs');
          try { return writeJson(res, 200, mod.removeTeam(name)); }
          catch (err) {
            return writeJson(res, 404, { error: err?.message || String(err), code: err?.code });
          }
}

export async function tasksList(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          const mod = await import('../../tasks.mjs');
          return writeJson(res, 200, mod.listTasks());
}

export async function taskTranscript(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          const m = url.pathname.match(/^\/tasks\/([^/]+)\/transcript$/);
          const id = m[1];
          const mod = await import('../../tasks.mjs');
          const t = mod.getTask(id);
          if (!t) return writeJson(res, 404, { error: `no task "${id}"` });
          const fmt = String(url.searchParams.get('format') || 'text');
          if (fmt === 'json') return writeJson(res, 200, t);
          const body = mod.formatTranscript(t, fmt);
          const mime = fmt === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8';
          res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache' });
          return res.end(body);
}

export async function taskGet(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          const id = url.pathname.split('/').pop();
          const mod = await import('../../tasks.mjs');
          const t = mod.getTask(id);
          if (!t) return writeJson(res, 404, { error: `no task "${id}"` });
          return writeJson(res, 200, t);
}

export async function taskDelete(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          const id = url.pathname.split('/').pop();
          const mod = await import('../../tasks.mjs');
          try { return writeJson(res, 200, mod.removeTask(id)); }
          catch (err) {
            return writeJson(res, 404, { error: err?.message || String(err), code: err?.code });
          }
}

export async function taskAction(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
          const m = url.pathname.match(/^\/tasks\/([^/]+)\/(done|abandon)$/);
          const id = m[1];
          const action = m[2];
          const mod = await import('../../tasks.mjs');
          try {
            const next = mod.patchTask(id, { status: action === 'done' ? 'done' : 'abandoned' });
            return writeJson(res, 200, next);
          } catch (err) {
            return writeJson(res, 404, { error: err?.message || String(err), code: err?.code });
          }
}

