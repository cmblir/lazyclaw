// lib/inbound_client.mjs — the channel-listener -> daemon bridge.
//
// Phase 2 of the unified gateway: a channel listener no longer calls the
// provider inline (its own per-process history Map). Instead it POSTs each
// inbound message to the always-on daemon's session-bearing POST /inbound,
// which binds {channel, externalId} -> a persistent session, hydrates prior
// turns, runs the provider, and persists the turn. The result is one shared
// agent (session + memory + skills) across chat, the dashboard, and every
// channel — plus cross-channel /handoff lights up for free.

export class InboundClientError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'InboundClientError';
    this.code = code || 'INBOUND_ERR';
    this.status = status || 0;
  }
}

// A connection refusal means the daemon isn't up yet (e.g. still starting, or
// momentarily restarting under a service manager) — worth a short backoff.
// Definitive HTTP answers (403/4xx/5xx) are NOT retried.
function isConnRefused(err) {
  if (!err) return false;
  if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') return true;
  if (err.cause && (err.cause.code === 'ECONNREFUSED' || err.cause.code === 'ECONNRESET')) return true;
  return /ECONNREFUSED|ECONNRESET|fetch failed|socket hang up/i.test(err.message || '');
}

export async function postInbound(opts, deps = {}) {
  const { url, authToken, channel, externalId, senderId, text, provider, model } = opts;
  const f = deps.fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') throw new InboundClientError('no fetch implementation available', 'NO_FETCH');
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const retries = Number.isFinite(deps.retries) ? deps.retries : 5;
  const backoffMs = Number.isFinite(deps.backoffMs) ? deps.backoffMs : 250;
  const endpoint = String(url).replace(/\/+$/, '') + '/inbound';

  const payload = { text };
  if (channel) payload.channel = channel;
  if (externalId != null && externalId !== '') payload.externalId = String(externalId);
  if (senderId != null && senderId !== '') payload.senderId = String(senderId);
  if (provider) payload.provider = provider;
  if (model) payload.model = model;
  const headers = { 'content-type': 'application/json' };
  if (authToken) headers['authorization'] = `Bearer ${authToken}`;

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let resp;
    try {
      resp = await f(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
    } catch (err) {
      lastErr = err;
      if (isConnRefused(err) && attempt < retries) { await sleep(backoffMs * (attempt + 1)); continue; }
      throw new InboundClientError(`daemon unreachable at ${endpoint}: ${err?.message || err}`, 'DAEMON_UNREACHABLE');
    }
    if (resp.status === 403) throw new InboundClientError('sender not paired', 'NOT_PAIRED', 403);
    if (!resp.ok) {
      let detail = '';
      try { detail = await resp.text(); } catch { /* body is best-effort */ }
      throw new InboundClientError(`daemon /inbound returned ${resp.status}${detail ? ': ' + detail.slice(0, 200) : ''}`, 'HTTP_ERROR', resp.status);
    }
    try { return await resp.json(); }
    catch (err) { throw new InboundClientError(`bad JSON from /inbound: ${err?.message || err}`, 'BAD_JSON', resp.status); }
  }
  throw new InboundClientError(`daemon unreachable at ${endpoint} after ${retries + 1} attempts: ${lastErr?.message || lastErr}`, 'DAEMON_UNREACHABLE');
}

// Build the per-message handler a Channel calls. Shared by slack/telegram/
// matrix listeners (they differ only in channel name + slack's @mention
// strip). The handler returns the reply string to post back, or null to stay
// silent (empty input, unpaired sender, empty daemon reply).
export function makeInboundHandler(opts, deps = {}) {
  const { channel, daemonUrl, daemonToken, provider, model } = opts;
  const post = deps.postInbound || postInbound;
  const log = deps.log || ((s) => process.stderr.write(s));
  const stripMention = channel === 'slack';

  return async ({ threadId, text, senderId } = {}) => {
    let cleaned = String(text || '');
    if (stripMention) cleaned = cleaned.replace(/<@[A-Z0-9]+>/g, '');
    cleaned = cleaned.trim();
    if (!cleaned) { log(`[${channel}] dropping empty inbound (after mention strip)\n`); return null; }
    try {
      const out = await post({ url: daemonUrl, authToken: daemonToken, channel, externalId: threadId, senderId, text: cleaned, provider, model });
      const reply = out && typeof out.reply === 'string' ? out.reply : '';
      if (!reply.trim()) { log(`[${channel}] daemon returned empty reply — not posting\n`); return null; }
      return reply;
    } catch (err) {
      // Unpaired senders are dropped silently — that is what pairing is for.
      if (err && err.code === 'NOT_PAIRED') { log(`[${channel}] sender not paired — ignoring\n`); return null; }
      // Anything else: log the detail to stderr (operator), but post only a
      // generic line to the channel so we never leak internals to users.
      log(`[${channel}] inbound bridge error: ${err?.message || err}\n`);
      return '(agent unavailable — backend not reachable)';
    }
  };
}
