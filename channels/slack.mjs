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
import { SlackError, readSlackEnv, validateEnv } from './slack_env.mjs';

// Re-exported for compatibility (split out under the file-size ratchet).
export { SlackError, readSlackEnv } from './slack_env.mjs';

// Decide whether a Socket Mode event should drive a handler call.
// Pulled out of dispatchEvent so we can unit-test the filter without
// standing up a WebSocket. Returns false (= skip) for:
//   - non-objects / null
//   - the bot's own message in any of the four wire shapes Slack uses
//     (legacy bot_id, legacy bot_message subtype, modern bot_profile.id,
//     or the message.user field matching our cached auth.test user_id —
//     this last one is the chat:write.customize trap that caused the
//     v4.2.0 listener-loop)
//   - non-message-shaped events (we only handle `message` and
//     `app_mention`)
//   - empty / whitespace-only text bodies (defense in depth so a
//     stray blocks-only post can't loop us back into "(empty message)"
//     fallback)
export function shouldDispatchEvent(event, { selfUserId = null, selfBotId = null } = {}) {
  if (!event || typeof event !== 'object') return false;
  if (event.bot_id || event.subtype === 'bot_message') return false;
  if (selfUserId && event.user === selfUserId) return false;
  if (selfBotId && event.bot_id === selfBotId) return false;
  if (selfBotId && event.bot_profile && event.bot_profile.id === selfBotId) return false;
  if (event.type !== 'app_mention' && event.type !== 'message') return false;
  const text = typeof event.text === 'string' ? event.text : '';
  if (text.trim() === '') return false;
  return true;
}

export class SlackChannel extends Channel {
  constructor(opts = {}) {
    super('slack');
    this._env = { ...readSlackEnv(), ...opts };
    this._requireInbound = opts.requireInbound !== false; // default true
    this._socketHandle = null; // populated when Socket Mode connects
    // Diagnostic sink for internal errors that must never reach the channel.
    // Same shape as telegram/matrix; overridden by start()/_connectSocketMode.
    this._logger = () => {};
  }

  async start(handler, opts = {}) {
    // Validate up-front so a missing-token daemon fails loudly at boot
    // (the Phase 8 spec test asserts this).
    validateEnv(this._env, { requireInbound: this._requireInbound });
    await super.start(handler, opts);
    if (typeof opts.logger === 'function') this._logger = opts.logger;
    // Socket Mode connect is intentionally deferred — we keep the
    // adapter pure for the test surface; the production wiring imports
    // @slack/socket-mode or implements the WS handshake directly and
    // funnels every inbound event through _simulateInbound.
    return this;
  }

  // Called by Socket Mode wiring (or tests) for every inbound message
  // routed to this app. The handler returns the bot's reply; the
  // adapter posts it back to Slack in the same thread. A null /
  // empty-string reply skips the send entirely (Phase 19.2) so a
  // handler that decided to stay silent — e.g. the listener dropping
  // an empty-after-mention-strip inbound — doesn't leak a "(empty
  // reply)" placeholder into the channel.
  async _simulateInbound(text, threadId, senderId = null, messageId = null) {
    let reply;
    try {
      reply = await this._processInbound({ threadId, text, gateInput: { key: senderId, senderId, messageId } });
    } catch (err) {
      if (err instanceof ChannelGated || err?.code === 'CHANNEL_GATED') {
        await this.send(threadId, `(gated: ${err.message})`);
        return;
      }
      // An unexpected handler/transport error may carry internal detail — a
      // provider's ApiError message is built from the upstream response body
      // (providers/anthropic.mjs: `anthropic api ${status}: ${body.slice(0,200)}`),
      // so echoing it put an upstream payload in front of whoever is talking to
      // the bot. Reply a generic notice and log the full error to the diagnostic
      // sink only — matching telegram.mjs and matrix.mjs, which already did this.
      this._logger(`[slack] handler error: ${err?.stack || err?.message || err}\n`);
      try {
        await this.send(threadId, '(internal error)');
      } catch (sendErr) {
        this._logger(`[slack] failed to deliver error notice: ${sendErr?.message || sendErr}\n`);
      }
      return;
    }
    if (reply == null || (typeof reply === 'string' && reply.trim() === '')) return;
    await this.send(threadId, reply);
  }

  // The base _processInbound forwards { channel, threadId, text }; we enrich
  // the event with senderId (the Slack user id) so the listener bridge can
  // pass it to the daemon's /inbound pairing gate — without it, Slack is the
  // one channel that can never be pairing-gated. Mirrors telegram/matrix;
  // adds a field, never drops one.
  async _processInbound({ threadId, text, gateInput }) {
    if (this._gate) {
      const verdict = this._gate.check(gateInput || {});
      if (!verdict.ok) {
        const err = new Error(verdict.reason || 'denied');
        err.code = 'CHANNEL_GATED';
        throw err;
      }
    }
    if (!this._handler) throw new Error(`channel "${this.name}" has no handler`);
    return await this._handler({
      channel: this.name,
      threadId,
      text,
      senderId: gateInput && gateInput.senderId != null ? gateInput.senderId : null,
      messageId: gateInput && gateInput.messageId != null ? gateInput.messageId : null,
    });
  }

  // Translate a target spec like `slack:#deploys` or `slack:U012345` into
  // a Slack `channel` string. Threads are addressed by a `threadId` of
  // shape `<channel>:<thread_ts>` or plain channel/user id.
  //
  // opts (Phase 16):
  //   username: string  — overrides the bot's display name for this
  //                       single message (requires chat:write.customize
  //                       scope on the bot token). Silently no-op when
  //                       the scope is missing.
  //   icon_emoji: string — e.g. ":rocket:" — same scope.
  async send(threadId, text, opts = {}) {
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
    const body = {
      channel,
      text: String(text),
      ...(thread_ts ? { thread_ts } : {}),
      ...(opts && opts.username ? { username: String(opts.username) } : {}),
      ...(opts && opts.icon_emoji ? { icon_emoji: String(opts.icon_emoji) } : {}),
    };
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
  // opts.onDead?: (err) => void — called when the reconnect chain gives up
  //   for good. Default THROWS on the next tick so an always-on process
  //   crashes loudly (and a service manager restarts it) instead of sitting
  //   alive with a permanently dead socket.
  async _connectSocketMode(opts = {}) {
    const { connectSocketMode } = await import('./slack_socket.mjs');
    return connectSocketMode(this, opts);
  }

  // Mark an inbound message as "being worked on" without spamming the
  // channel. Tries the :eyes: reaction first (silent UX). When
  // reactions:write is missing we used to fall back to a text post
  // ("확인해보겠습니다…") which doubled the noise per turn; Phase 19.2
  // dropped that fallback so the channel stays clean when the scope
  // is unavailable. The operator can flip reactions:write on at any
  // time to bring the visible signal back.
  //
  // Exposed as a method (not closure-private in dispatchEvent) so the
  // listener-noise unit tests can drive it directly.
  async _ackInbound(channel, sourceTs, logger = () => {}) {
    const eyesOk = await this._reaction('add', channel, sourceTs, 'eyes');
    if (!eyesOk) {
      logger('[slack] reactions:write missing — silent ack only (no text fallback)\n');
    }
    return eyesOk;
  }

  // Best-effort chat.delete — used by typing-indicator workflows where
  // we post a placeholder and want to clean it up. Returns true on
  // success, silent false otherwise.
  async deleteMessage(channel, ts) {
    if (!this._env.botToken || !channel || !ts) return false;
    const url = `${this._env.apiBase.replace(/\/$/, '')}/chat.delete`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this._env.botToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel, ts }),
      });
      if (!res.ok) return false;
      const json = await res.json().catch(() => ({}));
      return !!json.ok;
    } catch {
      return false;
    }
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
