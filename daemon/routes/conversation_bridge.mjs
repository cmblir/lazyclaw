// Daemon route handlers (conversation bridges), extracted verbatim from
// conversation.mjs to keep that file under the size gate. These two handlers
// are the non-streaming bridge routes — exec-approval long-poll and the
// thread handoff/migration — and share none of the SSE streaming machinery in
// conversation.mjs. Bodies are byte-identical to their original form; only the
// file location changed. Re-exported from conversation.mjs so the route table
// namespace still exposes them unchanged.
import { readJson, writeJson, openThreads, handoffWithRollback } from './_deps.mjs';

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
