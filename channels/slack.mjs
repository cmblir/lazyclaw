// Slack channel adapter.
//
// Reads three secrets from the environment ONLY (never from goal files,
// never logged):
//   SLACK_BOT_TOKEN       xoxb-… — used to call chat.postMessage etc.
//   SLACK_APP_TOKEN       xapp-… — required for Socket Mode (inbound)
//   SLACK_SIGNING_SECRET  …      — used to verify webhook payloads when
//                                  we add Events API mode (not yet)
//
// Outbound (`send(threadId, text)`) only needs the bot token. Inbound
// arrives via Socket Mode — `_connectSocketMode()` opens a WebSocket to
// Slack's gateway (negotiated by `apps.connections.open`) and dispatches
// every `events_api` envelope through `_simulateInbound(text, threadId)`.
// `start()` only validates env so unit tests can drive `_simulateInbound`
// directly without bringing up a WebSocket; the CLI's `slack listen`
// subcommand calls `_connectSocketMode()` explicitly after `start()`.
//
// SLACK_API_BASE (test-only) overrides the Slack Web API base URL so the
// Phase 8 spec can point the adapter at a local mock HTTP server.

import { Channel, ChannelGated } from './base.mjs';

const DEFAULT_API_BASE = 'https://slack.com/api';

export class SlackError extends Error {
  constructor(message, code, missing) {
    super(message);
    this.name = 'SlackError';
    this.code = code || 'SLACK_ERR';
    if (Array.isArray(missing)) this.missing = missing;
  }
}

export function readSlackEnv(env = process.env) {
  const out = {
    botToken: env.SLACK_BOT_TOKEN || null,
    appToken: env.SLACK_APP_TOKEN || null,
    signingSecret: env.SLACK_SIGNING_SECRET || null,
    apiBase: env.SLACK_API_BASE || DEFAULT_API_BASE,
  };
  return out;
}

function validateEnv(env, { requireInbound = false } = {}) {
  const missing = [];
  if (!env.botToken) missing.push('SLACK_BOT_TOKEN');
  else if (!env.botToken.startsWith('xoxb-')) {
    throw new SlackError('SLACK_BOT_TOKEN must start with "xoxb-"', 'SLACK_BAD_TOKEN', ['SLACK_BOT_TOKEN']);
  }
  if (requireInbound) {
    if (!env.appToken) missing.push('SLACK_APP_TOKEN');
    else if (!env.appToken.startsWith('xapp-')) {
      throw new SlackError('SLACK_APP_TOKEN must start with "xapp-"', 'SLACK_BAD_TOKEN', ['SLACK_APP_TOKEN']);
    }
    if (!env.signingSecret) missing.push('SLACK_SIGNING_SECRET');
  }
  if (missing.length) {
    throw new SlackError(`missing Slack env vars: ${missing.join(', ')}`, 'SLACK_MISSING_ENV', missing);
  }
}

export class SlackChannel extends Channel {
  constructor(opts = {}) {
    super('slack');
    this._env = { ...readSlackEnv(), ...opts };
    this._requireInbound = opts.requireInbound !== false; // default true
    this._socketHandle = null; // populated when Socket Mode connects
  }

  async start(handler, opts = {}) {
    // Validate up-front so a missing-token daemon fails loudly at boot
    // (the Phase 8 spec test asserts this).
    validateEnv(this._env, { requireInbound: this._requireInbound });
    await super.start(handler, opts);
    // Socket Mode connect is intentionally deferred — we keep the
    // adapter pure for the test surface; the production wiring imports
    // @slack/socket-mode or implements the WS handshake directly and
    // funnels every inbound event through _simulateInbound.
    return this;
  }

  // Called by Socket Mode wiring (or tests) for every inbound message
  // routed to this app. The handler returns the bot's reply; the
  // adapter posts it back to Slack in the same thread.
  async _simulateInbound(text, threadId) {
    let reply;
    try {
      reply = await this._processInbound({ threadId, text, gateInput: {} });
    } catch (err) {
      if (err instanceof ChannelGated || err?.code === 'CHANNEL_GATED') {
        await this.send(threadId, `(gated: ${err.message})`);
        return;
      }
      await this.send(threadId, `(error: ${err?.message || err})`);
      return;
    }
    await this.send(threadId, reply);
  }

  // Translate a target spec like `slack:#deploys` or `slack:U012345` into
  // a Slack `channel` string. Threads are addressed by a `threadId` of
  // shape `<channel>:<thread_ts>` or plain channel/user id.
  async send(threadId, text) {
    if (!this._env.botToken) throw new SlackError('cannot send without SLACK_BOT_TOKEN', 'SLACK_NO_TOKEN');
    let channel = threadId, thread_ts;
    if (typeof threadId === 'string' && threadId.includes(':')) {
      const ix = threadId.indexOf(':');
      // Allow the test-style "slack:#chan" prefix to flow through.
      if (threadId.slice(0, ix) === 'slack') {
        channel = threadId.slice(ix + 1);
      } else {
        channel = threadId.slice(0, ix);
        thread_ts = threadId.slice(ix + 1);
      }
    }
    const url = `${this._env.apiBase.replace(/\/$/, '')}/chat.postMessage`;
    const body = { channel, text: String(text), ...(thread_ts ? { thread_ts } : {}) };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this._env.botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new SlackError(`slack send failed: HTTP ${res.status}`, 'SLACK_HTTP_FAIL');
    }
    const json = await res.json().catch(() => ({}));
    if (!json.ok) {
      throw new SlackError(`slack send failed: ${json.error || 'unknown'}`, 'SLACK_API_FAIL');
    }
    return json;
  }

  // Open a Socket Mode WebSocket and route every inbound event through
  // `_simulateInbound`. Returns when the listener is connected; the
  // returned object exposes `.close()` for graceful shutdown.
  //
  // opts.logger?: (line: string) => void — diagnostic sink (stderr in
  //   the CLI, no-op in tests).
  // opts.maxReconnects?: number — cap reconnect attempts (default ∞).
  async _connectSocketMode({ logger = () => {}, maxReconnects = Infinity } = {}) {
    validateEnv(this._env, { requireInbound: true });
    if (typeof globalThis.WebSocket !== 'function') {
      throw new SlackError(
        'global WebSocket is not available — Node 22+ required for Socket Mode',
        'SLACK_NO_WS'
      );
    }
    const apiBase = this._env.apiBase.replace(/\/$/, '');
    const appToken = this._env.appToken;
    const seenEnvelopes = new Set();
    let closed = false;
    let ws = null;
    let attempts = 0;

    const openConnection = async () => {
      const url = `${apiBase}/apps.connections.open`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${appToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
      if (!res.ok) {
        throw new SlackError(`apps.connections.open HTTP ${res.status}`, 'SLACK_OPEN_HTTP');
      }
      const json = await res.json().catch(() => ({}));
      if (!json.ok || !json.url) {
        throw new SlackError(`apps.connections.open failed: ${json.error || 'no url'}`, 'SLACK_OPEN_FAIL');
      }
      return json.url;
    };

    // (channel, ts) dedupe — a single user message can fire both
    // `message` and `app_mention` events in the same channel. Both
    // arrive as separate Socket Mode envelopes (different envelope_id),
    // so the envelope_id-level dedupe upstream doesn't catch them. We
    // claim the pair on first dispatch and reject the second.
    const seenMessages = new Map();  // key → expiresAt(ms)
    const MSG_TTL_MS = 60_000;
    const claimMessage = (channel, ts) => {
      const key = `${channel}:${ts}`;
      const now = Date.now();
      // Sweep expired entries opportunistically so the map doesn't grow
      // unbounded over a long-running session.
      if (seenMessages.size > 256) {
        for (const [k, exp] of seenMessages) if (exp < now) seenMessages.delete(k);
      }
      const exp = seenMessages.get(key);
      if (exp && exp >= now) return false;
      seenMessages.set(key, now + MSG_TTL_MS);
      return true;
    };

    const dispatchEvent = async (event) => {
      if (!event || typeof event !== 'object') return;
      // Skip the bot's own messages so we don't loop on our own replies.
      if (event.bot_id || event.subtype === 'bot_message') return;
      if (event.type !== 'app_mention' && event.type !== 'message') return;
      // For DMs (`im`) channel_type is 'im'; for channel mentions we only
      // get app_mention events. Either way we have channel + ts.
      const text = typeof event.text === 'string' ? event.text : '';
      const channel = event.channel;
      const sourceTs = event.ts;                       // the message we react to
      const replyTs = event.thread_ts || event.ts;     // the thread root for replies
      if (!channel || !sourceTs) return;
      if (!claimMessage(channel, sourceTs)) {
        logger(`[slack] duplicate ${event.type} for ${channel}:${sourceTs} — skipping\n`);
        return;
      }
      const threadId = `${channel}:${replyTs}`;
      logger(`[slack] inbound ${event.type} from ${channel} (${text.length} chars)\n`);

      // Immediate acknowledgement so the user sees the bot picked up the
      // message before the LLM finishes. Prefer a reaction (no message
      // spam); fall back to a transient text reply when the workspace
      // doesn't grant reactions:write.
      const eyesOk = await this._reaction('add', channel, sourceTs, 'eyes');
      if (!eyesOk) {
        logger(`[slack] reactions:write missing — falling back to text ack\n`);
        try { await this.send(threadId, '_확인해보겠습니다…_'); }
        catch (err) { logger(`[slack] text ack failed: ${err?.message || err}\n`); }
      }

      try {
        await this._simulateInbound(text, threadId);
        if (eyesOk) {
          // Swap the "working" reaction for a "done" one so the user can
          // tell at a glance which messages have been answered.
          await this._reaction('remove', channel, sourceTs, 'eyes');
          await this._reaction('add', channel, sourceTs, 'white_check_mark');
        }
      } catch (err) {
        logger(`[slack] handler error: ${err?.message || err}\n`);
        if (eyesOk) {
          await this._reaction('remove', channel, sourceTs, 'eyes');
          await this._reaction('add', channel, sourceTs, 'x');
        }
      }
    };

    const connectOnce = () => new Promise((resolve, reject) => {
      let wsUrl;
      openConnection()
        .then((u) => { wsUrl = u; })
        .catch(reject)
        .then(() => {
          if (!wsUrl) return;
          logger(`[slack] socket-mode dialing wss gateway\n`);
          ws = new WebSocket(wsUrl);
          ws.addEventListener('open', () => {
            attempts = 0;
            logger(`[slack] socket-mode connected\n`);
            resolve();
          });
          ws.addEventListener('message', async (ev) => {
            let frame;
            try { frame = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); }
            catch { return; }
            if (frame.type === 'hello') {
              logger(`[slack] hello (num_connections=${frame.num_connections || '?'})\n`);
              return;
            }
            if (frame.type === 'disconnect') {
              logger(`[slack] disconnect requested (reason=${frame.reason || '?'})\n`);
              try { ws.close(1000); } catch { /* best-effort */ }
              return;
            }
            if (frame.type === 'events_api') {
              if (frame.envelope_id) {
                if (seenEnvelopes.has(frame.envelope_id)) return;
                seenEnvelopes.add(frame.envelope_id);
                // Bound the dedupe set so it doesn't grow forever.
                if (seenEnvelopes.size > 1024) {
                  const trimTo = 512;
                  const it = seenEnvelopes.values();
                  while (seenEnvelopes.size > trimTo) seenEnvelopes.delete(it.next().value);
                }
                try { ws.send(JSON.stringify({ envelope_id: frame.envelope_id })); }
                catch (err) { logger(`[slack] ack send failed: ${err?.message || err}\n`); }
              }
              const event = frame.payload?.event;
              await dispatchEvent(event);
            }
          });
          ws.addEventListener('close', () => {
            logger(`[slack] socket closed\n`);
            if (closed) return;
            attempts++;
            if (attempts > maxReconnects) {
              logger(`[slack] giving up after ${attempts} reconnect attempts\n`);
              return;
            }
            const backoff = Math.min(30000, 1000 * Math.pow(2, Math.min(attempts, 5)));
            logger(`[slack] reconnecting in ${backoff}ms (attempt ${attempts})\n`);
            setTimeout(() => { if (!closed) connectOnce().catch((e) => logger(`[slack] reconnect failed: ${e?.message || e}\n`)); }, backoff);
          });
          ws.addEventListener('error', (ev) => {
            // The 'error' event fires before 'close'; we let 'close' drive
            // the reconnect so we don't reconnect twice for one failure.
            logger(`[slack] socket error: ${ev?.message || 'unknown'}\n`);
          });
        });
    });

    await connectOnce();
    this._socketHandle = {
      disconnect: async () => {
        closed = true;
        try { ws?.close(1000); } catch { /* best-effort */ }
      },
    };
    return this._socketHandle;
  }

  // Best-effort reaction add / remove. Returns true on success. Silent
  // false on any failure (missing reactions:write scope, transport
  // error, …) so callers can chain without noise.
  async _reaction(action, channel, ts, name) {
    if (!this._env.botToken || !channel || !ts) return false;
    const endpoint = action === 'remove' ? 'reactions.remove' : 'reactions.add';
    const url = `${this._env.apiBase.replace(/\/$/, '')}/${endpoint}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this._env.botToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel, timestamp: ts, name }),
      });
      if (!res.ok) return false;
      const json = await res.json().catch(() => ({}));
      return !!json.ok;
    } catch {
      return false;
    }
  }

  async stop() {
    if (this._socketHandle && typeof this._socketHandle.disconnect === 'function') {
      try { await this._socketHandle.disconnect(); } catch { /* best-effort */ }
    }
    this._socketHandle = null;
    await super.stop();
  }
}
