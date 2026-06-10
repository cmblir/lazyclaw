// Daemon route handlers (conversation), extracted verbatim from makeHandler (D5).
// Each handler takes the per-request dispatch context `c` and returns the
// HTTP response. Bodies are unchanged; only the dispatch wrapper is new.
import { fs, nodePath, PROVIDERS, PROVIDER_INFO, maskApiKey, costFromUsage, RATE_CARD_SHAPE, composeSystemPrompt, listSkills, loadSkill, skillPath, installSkill, removeSkill, parseFrontmatter, skillsDefaultConfigDir, indexDb, skillSynth, sandboxListBackends, summarizeState, listWorkflowSessions, loadWorkflowState, aggregateNodeStats, validateConfig, validateRates, fileExists, readJson, readTextBody, writeJson, writeSseHead, writeSse, statusForProviderError, checkCostCap, accumulateMetricsFromCost, resolveProvider, openThreads, handoffWithRollback, openDedup } from './_deps.mjs';
import { randomBytes } from 'node:crypto';

// F5 — mint a fresh session id for a newly-seen channel:externalId binding.
// Kept filename-local (threads.mjs's newThreadId isn't exported); the `ib_`
// hex form satisfies sessions.mjs sessionPath validation (no / \ . ..).
function newInboundSessionId() {
  return 'ib_' + randomBytes(8).toString('hex');
}

export async function execRequest(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

export async function chat(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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
            // Abort the provider when the SSE client disconnects — otherwise it
            // keeps generating (burning tokens/cost) for a caller that's gone.
            // Mirrors the /agent stream path.
            const ac = new AbortController();
            req.on('aborted', () => ac.abort());
            res.on('close', () => { if (!res.writableEnded) ac.abort(); });
            try {
              for await (const chunk of prov.sendMessage(messages, { ...sendOpts, signal: ac.signal })) {
                if (ac.signal.aborted) break;
                writeSse(res, 'token', { text: chunk });
                await new Promise(r => setImmediate(r));
              }
              if (!ac.signal.aborted) {
                if (captured) writeSse(res, 'usage', captured);
                const cost = computeCost();
                if (cost) writeSse(res, 'cost', cost);
                writeSse(res, 'done', { ok: true });
              }
              return res.end();
            } catch (err) {
              if (err?.code === 'ABORT' || ac.signal.aborted) return res.end();
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

export async function inbound(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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
          // F5 — when the relaying bot identifies its channel + external
          // conversation id, bind {channel, externalId} -> a persistent
          // session so context follows across channels (and across a
          // /handoff). Without those fields we keep the original stateless
          // one-shot behavior, byte-compatible with existing callers.
          const cfgDir = ctx.sessionsDirGetter();
          const channel = (typeof body.channel === 'string' && body.channel) ? body.channel : null;
          const externalId = (body.externalId != null && String(body.externalId)) ? String(body.externalId) : null;
          // Phase 4 — idempotency. When the relay supplies the native message
          // id, claim `${channel}:${messageId}` BEFORE any turn is persisted:
          // a recorded duplicate replays the prior reply (no provider call,
          // no double appendTurn); an in-flight duplicate answers empty so
          // the listener stays silent while the first request finishes.
          const messageId = (body.messageId != null && String(body.messageId)) ? String(body.messageId) : null;
          let dedup = null;
          let dedupKey = null;
          if (channel && messageId) {
            dedup = openDedup(cfgDir);
            dedupKey = `${channel}:${messageId}`;
            const seen = dedup.claim(dedupKey);
            if (seen.dup) {
              if (seen.pending) return writeJson(res, 200, { reply: '', threadId: body.threadId || null, duplicate: true });
              const e = seen.entry;
              const dupOut = { reply: e.reply, threadId: e.threadId, duplicate: true };
              if (e.sessionId) dupOut.sessionId = e.sessionId;
              return writeJson(res, 200, dupOut);
            }
          }
          let threads = null;
          let bound = null;
          let sessionId = null;
          if (channel && externalId) {
            threads = openThreads(cfgDir);
            bound = threads.findByExternal(channel, externalId);
            if (bound) {
              sessionId = bound.sessionId;
            } else {
              sessionId = newInboundSessionId();
              threads.upsert({ channel, externalId, sessionId });
              bound = threads.findByExternal(channel, externalId);
            }
          }
          // Hydrate prior turns for a bound session (mirrors POST /agent).
          const messages = sessionId
            ? ctx.sessionsMod.loadTurns(sessionId, cfgDir).map((t) => ({ role: t.role, content: t.content }))
            : [];
          messages.push({ role: 'user', content: text });
          if (sessionId) ctx.sessionsMod.appendTurn(sessionId, 'user', text, cfgDir);
          let acc = '';
          let inboundUsage = null;
          try {
            for await (const chunk of resolved.provider.sendMessage(
              messages,
              { apiKey: cfg['api-key'], model: body.model || cfg.model, onUsage: (u) => { inboundUsage = u; } },
            )) acc += chunk;
          } catch (err) {
            // Free the idempotency claim — a provider failure must stay
            // retryable, not poison the message id.
            if (dedup) dedup.release(dedupKey);
            const m = statusForProviderError(err);
            return writeJson(res, m.status, { error: err?.message || String(err), code: err?.code || null }, m.headers || {});
          }
          if (sessionId) {
            ctx.sessionsMod.appendTurn(sessionId, 'assistant', acc, cfgDir);
            // Refresh lastTurnAt on the binding.
            threads.upsert({ channel, externalId, sessionId, threadId: bound.threadId });
          }
          // Feed the running spend total so the cost cap can actually trip
          // on /inbound traffic (mirrors POST /agent / POST /chat).
          if (inboundUsage && cfg.rates) {
            try {
              const c = costFromUsage({ provider: provName, model: body.model || cfg.model, usage: inboundUsage }, cfg.rates);
              if (c) accumulateMetricsFromCost(metrics, inboundUsage, c);
            } catch { /* cost is best-effort; never block a reply on it */ }
          }
          const out = { reply: acc, threadId: bound ? bound.threadId : (body.threadId || null) };
          if (sessionId) out.sessionId = sessionId;
          if (dedup) dedup.record(dedupKey, { reply: acc, threadId: out.threadId, sessionId });
          if (sessionId) {
            // Phase 4 — close the post-task learning loop on channel turns,
            // mirroring the chat REPL's fire-and-forget hook (run_turn.mjs).
            // Only session-bound turns learn (a stateless one-shot relay is
            // not a conversation); trainer resolution inside runLearning
            // handles cfg.trainer 'auto' -> claude-cli ($0) routing. The
            // dedup short-circuit above guarantees at most one learning
            // pass per native message id.
            const learnTurns = [
              { agent: 'user', text, ts: new Date().toISOString() },
              { agent: 'chat', text: acc, ts: new Date().toISOString() },
            ];
            queueMicrotask(() => {
              import('../../mas/learning.mjs')
                .then((mod) => mod.runLearning('post-task', {
                  agent: { name: 'chat', provider: provName, model: body.model || cfg.model, role: '' },
                  task: { id: sessionId, title: '(channel turn)', turns: learnTurns },
                  configDir: cfgDir,
                  cfg,
                }))
                .catch(() => { /* learning loop is best-effort */ });
            });
          }
          return writeJson(res, 200, out);
}

export async function handoff(c) {
  const { ctx, res, req } = c;
          // F6 — re-point a thread to a new channel/externalId so a later
          // inbound on the target resumes the SAME session (context follows).
          // When the in-process gateway registered a live sender for the
          // target channel (ctx.channelSenders), the target gets a resume
          // marker and a FAILED notify rolls the binding back (502). Without
          // a sender (bare daemon) the migration persists silently — the
          // session still follows on the next inbound.
          let body;
          try { body = await readJson(req); }
          catch (e) { return writeJson(res, 400, { error: `invalid JSON body: ${e.message}` }); }
          const threadId = typeof body.threadId === 'string' ? body.threadId.trim() : '';
          const target = typeof body.target === 'string' ? body.target.trim() : '';
          const externalId = body.externalId != null ? String(body.externalId).trim() : '';
          if (!threadId || !target || !externalId) {
            return writeJson(res, 400, { error: 'threadId, target, and externalId are required' });
          }
          const cfgDir = ctx.sessionsDirGetter();
          const threads = openThreads(cfgDir);
          const liveSend = (ctx.channelSenders && typeof ctx.channelSenders.get === 'function')
            ? ctx.channelSenders.get(target)
            : undefined;
          try {
            const next = await handoffWithRollback({
              threads, threadId, target, externalId,
              note: typeof body.note === 'string' ? body.note : '',
              send: liveSend,
            });
            return writeJson(res, 200, {
              threadId: next.threadId, channel: next.channel,
              externalId: next.externalId, sessionId: next.sessionId,
            });
          } catch (err) {
            if (err?.code === 'THREAD_NOT_FOUND') return writeJson(res, 404, { error: err.message, code: 'THREAD_NOT_FOUND' });
            if (err?.code === 'HANDOFF_SEND_FAILED') return writeJson(res, 502, { error: err.message, code: 'HANDOFF_SEND_FAILED' });
            return writeJson(res, 400, { error: err?.message || String(err) });
          }
}

export async function agent(c) {
  const { ctx, logger, metrics, gateway, costCap, cachedByName, gwConfigDir, nudgeSuggestionsRing, workflowStateDir, req, res, method, path, route, url, sessionMatch, providerMatch, providerTestMatch, sessionExportMatch, skillMatch, workflowMatch, configKeyMatch, ratesKeyMatch } = c;
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

