// Daemon route handlers (conversation), extracted verbatim from makeHandler (D5).
// Each handler takes the per-request dispatch context `c` and returns the
// HTTP response. Bodies are unchanged; only the dispatch wrapper is new.
import { fs, nodePath, PROVIDERS, PROVIDER_INFO, maskApiKey, costFromUsage, RATE_CARD_SHAPE, composeSystemPrompt, listSkills, loadSkill, skillPath, installSkill, removeSkill, parseFrontmatter, skillsDefaultConfigDir, indexDb, skillSynth, sandboxListBackends, summarizeState, listWorkflowSessions, loadWorkflowState, aggregateNodeStats, validateConfig, validateRates, fileExists, readJson, readTextBody, writeJson, writeSseHead, writeSse, statusForProviderError, armStreamDeadline, checkCostCap, accumulateMetricsFromCost, accountTurnCost, makeTeamUsageAccountant, resolveProvider, openThreads, handoffWithRollback, openDedup, enqueueLearning } from './_deps.mjs';
import { randomBytes } from 'node:crypto';
import { routeInboundToTeam } from '../lib/team_inbound.mjs';

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
            // Always capture usage so the cost cap can track real spend;
            // body.usage only controls whether we RETURN it to the caller.
            onUsage: (u) => { captured = u; },
          };
          // Cost lookup: body.cost:true asks the daemon to attach a cost
          // block when usage was captured AND cfg.rates has a card for
          // the active provider/model. Pure arithmetic — no extra wire
          // calls. Inline rather than helper-extract because the two
          // response paths (stream / non-stream) need to bind it
          // differently (SSE event vs JSON field).
          // Always accumulate cost into metrics (so checkCostCap tracks real
          // spend on the NEXT request); return the cost block only when
          // body.cost asked for it. Call once per turn.
          const account = () => accountTurnCost({
            metrics, usage: captured, provider: provName, model: body.model || cfg.model,
            rates: cfg.rates, wantCost: body.cost, costFromUsage,
          });
          if (body.stream === true) {
            writeSseHead(res);
            // Abort the provider when the SSE client disconnects — otherwise it
            // keeps generating (burning tokens/cost) for a caller that's gone.
            // Mirrors the /agent stream path.
            const ac = new AbortController();
            req.on('aborted', () => ac.abort());
            res.on('close', () => { if (!res.writableEnded) ac.abort(); });
            // Opt-in wall-clock cap (cfg.chat.maxStreamMs): the per-chunk idle
            // timeout can't bound a model that streams steadily for minutes.
            const maxStreamMs = Number(cfg.chat?.maxStreamMs) || 0;
            const _deadline = armStreamDeadline(ac, maxStreamMs);
            try {
              for await (const chunk of prov.sendMessage(messages, { ...sendOpts, signal: ac.signal })) {
                if (ac.signal.aborted) break;
                // Yield the event loop only under backpressure (socket buffer
                // full) instead of on every token — writeSse returns false when
                // the buffer is full.
                if (!writeSse(res, 'token', { text: chunk })) await new Promise(r => setImmediate(r));
              }
              // Tell the client the reply was cut by the cap (vs a clean finish).
              if (_deadline.hit()) writeSse(res, 'truncated', { reason: 'maxStreamMs', maxStreamMs });
              if (!ac.signal.aborted) {
                const cost = account();
                if (captured && body.usage) writeSse(res, 'usage', captured);
                if (cost) writeSse(res, 'cost', cost);
                writeSse(res, 'done', { ok: true });
              }
              return res.end();
            } catch (err) {
              if (err?.code === 'ABORT' || ac.signal.aborted) {
                if (_deadline.hit()) writeSse(res, 'truncated', { reason: 'maxStreamMs', maxStreamMs });
                return res.end();
              }
              writeSse(res, 'error', { message: err?.message || String(err) });
              return res.end();
            } finally {
              _deadline.disarm();
            }
          }
          let acc = '';
          try {
            for await (const chunk of prov.sendMessage(messages, sendOpts)) acc += chunk;
            const cost = account();
            const out = { reply: acc };
            if (captured && body.usage) out.usage = captured;
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
          // id, claim a key BEFORE any turn is persisted: a recorded duplicate
          // replays the prior reply (no provider call, no double appendTurn);
          // an in-flight duplicate answers empty so the listener stays silent
          // while the first request finishes. The key is scoped to the
          // CONVERSATION (`channel:externalId:messageId`) so a colliding or
          // forged messageId from another conversation can never replay this
          // one's reply or sessionId.
          const messageId = (body.messageId != null && String(body.messageId)) ? String(body.messageId) : null;
          let dedup = null;
          let dedupKey = null;
          if (channel && messageId) {
            dedup = openDedup(cfgDir);
            dedupKey = `${channel}:${externalId || ''}:${messageId}`;
            const seen = dedup.claim(dedupKey);
            if (seen.dup) {
              if (seen.pending) return writeJson(res, 200, { reply: '', threadId: body.threadId || null, duplicate: true });
              const e = seen.entry;
              const dupOut = { reply: e.reply, threadId: e.threadId, duplicate: true };
              if (e.sessionId) dupOut.sessionId = e.sessionId;
              return writeJson(res, 200, dupOut);
            }
          }
          // Everything from here to record() must free the pending claim on
          // ANY failure (not just provider errors) — otherwise a thrown
          // loadTurns/appendTurn would wedge the message id for the whole
          // pending TTL and retries would be silently dropped.
          let dedupRecorded = false;
          try {
          // L3 — Slack→team auto-routing. When the inbound channel is bound to a
          // team (team.slackChannel), drive the multi-agent task loop (which
          // emits live dashboard events as the agents work) and return its final
          // reply. Falls through to the single-shot path when no team is bound,
          // keeping existing single-agent channels byte-stable.
          if (channel) {
            // Account every team agent turn's spend so the cost cap covers team
            // traffic (it used to bypass the cap entirely), and abort the loop
            // mid-run the moment accumulated spend breaches the cap.
            const teamAc = new AbortController();
            const teamOnUsage = makeTeamUsageAccountant({
              metrics, costCap, rates: cfg.rates, costFromUsage, onBreach: () => teamAc.abort(),
            });
            const teamRouted = await routeInboundToTeam({
              cfg, channel, text, configDir: cfgDir,
              apiKey: cfg['api-key'], logger,
              onUsage: teamOnUsage, signal: teamAc.signal,
            }).catch((err) => {
              // `logger` here is the daemon's structured logger (object|null), not a
              // function — use its method API, never call it directly.
              try { logger?.warn?.('inbound_team_routing_failed', { err: err?.message || String(err) }); } catch { /* best-effort */ }
              return null;
            });
            if (teamRouted) {
              const out = { reply: teamRouted.reply, threadId: body.threadId || null, team: teamRouted.team, taskId: teamRouted.taskId };
              if (dedup) { dedup.record(dedupKey, { reply: teamRouted.reply, threadId: out.threadId }); dedupRecorded = true; }
              return writeJson(res, 200, out);
            }
            // No team bound — is the channel bound to a named workflow? If so,
            // run it with the message as {{input}} and reply with its output.
            // Falls through (byte-stable) when nothing is bound.
            const { workflowForChannel, runNamedWorkflow, namedReplyText } = await import('../../workflow/named.mjs');
            const wf = workflowForChannel(cfg, channel);
            if (wf) {
              try {
                const wfResult = await runNamedWorkflow(wf.name, cfg, { providerLookup: (n) => PROVIDERS[n] || null, input: text });
                const reply = namedReplyText(wfResult, wf) || '(workflow finished with no reply)';
                const out = { reply, threadId: body.threadId || null, workflow: wf.name };
                if (dedup) { dedup.record(dedupKey, { reply, threadId: out.threadId }); dedupRecorded = true; }
                return writeJson(res, 200, out);
              } catch (err) {
                try { logger?.warn?.('inbound_workflow_failed', { workflow: wf.name, err: err?.message || String(err) }); } catch { /* best-effort */ }
                // fall through to the single-shot provider reply
              }
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
            // A provider failure must stay retryable, not poison the message
            // id — the outer finally releases the claim.
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
          if (dedup) { dedup.record(dedupKey, { reply: acc, threadId: out.threadId, sessionId }); dedupRecorded = true; }
          if (sessionId) {
            // Phase 4 — close the post-task learning loop on channel turns,
            // mirroring the chat REPL's fire-and-forget hook (run_turn.mjs).
            // Only session-bound turns learn (a stateless one-shot relay is
            // not a conversation); trainer resolution inside runLearning
            // handles cfg.trainer 'auto' -> claude-cli ($0) routing. The
            // dedup short-circuit above guarantees at most one learning pass
            // per native message id, and enqueueLearning serialises the runs
            // (concurrency 1, bounded depth) so a message burst can't fan out
            // unbounded trainer LLM calls / claude-cli subprocesses.
            const learnTurns = [
              { agent: 'user', text, ts: new Date().toISOString() },
              { agent: 'chat', text: acc, ts: new Date().toISOString() },
            ];
            enqueueLearning(() =>
              import('../../mas/learning.mjs')
                .then((mod) => mod.runLearning('post-task', {
                  agent: { name: 'chat', provider: provName, model: body.model || cfg.model, role: '' },
                  task: { id: sessionId, title: '(channel turn)', turns: learnTurns },
                  configDir: cfgDir,
                  cfg,
                })));
          }
          return writeJson(res, 200, out);
          } finally {
            if (dedup && !dedupRecorded) dedup.release(dedupKey);
          }
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
            // Always capture usage for cap accounting; body.usage gates the return.
            onUsage: (u) => { agentCaptured = u; },
          };
          // Accumulate unconditionally; return the cost block only when asked.
          const accountAgent = () => accountTurnCost({
            metrics, usage: agentCaptured, provider: provName, model,
            rates: cfg.rates, wantCost: body.cost, costFromUsage,
          });

          if (body.stream === true) {
            writeSseHead(res);
            // Forward client disconnect to the provider so we don't keep
            // burning tokens after the consumer has gone away.
            const ac = new AbortController();
            req.on('aborted', () => ac.abort());
            res.on('close', () => { if (!res.writableEnded) ac.abort(); });
            // Opt-in wall-clock cap (cfg.chat.maxStreamMs) — bounds a turn that
            // streams steadily past the per-chunk idle timeout.
            const maxStreamMs = Number(cfg.chat?.maxStreamMs) || 0;
            const _deadline = armStreamDeadline(ac, maxStreamMs);
            // Typed streaming (Phase 1 wave-B): in ADDITION to the plain `token`
            // text frames, surface the provider's existing onToolUse/onThinking
            // callbacks as distinct SSE event types so a client can render tool
            // calls / thinking separately (parity with the Agent SDK typed
            // streams). Purely additive — the token/usage/cost/done/truncated
            // frames below are byte-unchanged, so token-only clients are
            // unaffected. Guard against writes after abort/end so a late
            // callback can't write to a torn-down socket.
            const emitTyped = (event, data) => {
              if (ac.signal.aborted || res.writableEnded) return;
              writeSse(res, event, data);
            };
            const typedSendOpts = {
              ...agentSendOpts,
              signal: ac.signal,
              // onUsage is left as agentSendOpts.onUsage (cap accounting): the
              // single end-of-stream `usage` frame below is unchanged, so the
              // usage-frame contract stays byte-stable (one frame, opt-in via
              // body.usage). Only the NEW tool_use/thinking events are wired
              // here — neither had a prior emission, so this is purely additive.
              onToolUse: (t) => emitTyped('tool_use', { type: 'tool_use', id: t?.id, name: t?.name, input: t?.input ?? {} }),
              onThinking: (text) => emitTyped('thinking', { type: 'thinking', text: String(text ?? '') }),
            };
            let acc = '';
            try {
              for await (const chunk of prov.sendMessage(messages, typedSendOpts)) {
                if (ac.signal.aborted) break;
                acc += chunk;
                // Backpressure: yield the event loop only when the socket
                // buffer is full (writeSse returns false), not on every token.
                if (!writeSse(res, 'token', { text: chunk })) await new Promise(r => setImmediate(r));
              }
              // On a cap-hit we still persist the partial turn (it's real output)
              // but tell the client it was truncated rather than a clean finish.
              if (_deadline.hit()) writeSse(res, 'truncated', { reason: 'maxStreamMs', maxStreamMs });
              if (sid && (!ac.signal.aborted || _deadline.hit())) ctx.sessionsMod.appendTurn(sid, 'assistant', acc, cfgDir);
              if (!ac.signal.aborted) {
                const cost = accountAgent();
                if (agentCaptured && body.usage) writeSse(res, 'usage', agentCaptured);
                if (cost) writeSse(res, 'cost', cost);
                writeSse(res, 'done', { ok: true });
              }
              return res.end();
            } catch (err) {
              if (err?.code === 'ABORT' || ac.signal.aborted) {
                if (_deadline.hit()) writeSse(res, 'truncated', { reason: 'maxStreamMs', maxStreamMs });
                // Client gave up — partial assistant turn is discarded.
                return res.end();
              }
              writeSse(res, 'error', { message: err?.message || String(err) });
              return res.end();
            } finally {
              _deadline.disarm();
            }
          }

          // Non-streaming: collect then return once. Reuse agentSendOpts
          // (carrying the optional onUsage capture) so usage lands in the
          // response when body.usage was set.
          let acc = '';
          try {
            for await (const chunk of prov.sendMessage(messages, agentSendOpts)) acc += chunk;
            if (sid) ctx.sessionsMod.appendTurn(sid, 'assistant', acc, cfgDir);
            const cost = accountAgent();
            const out = { reply: acc };
            if (agentCaptured && body.usage) out.usage = agentCaptured;
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

