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
// arrives via Socket Mode — we surface the entry point as
// `_simulateInbound(text, threadId)` so tests can drive the same flow
// without standing up a WebSocket. A future production wiring fills in
// the real Socket Mode listener and calls `_simulateInbound` (or the
// equivalent private method) for each event.
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

  async stop() {
    if (this._socketHandle && typeof this._socketHandle.disconnect === 'function') {
      try { await this._socketHandle.disconnect(); } catch { /* best-effort */ }
    }
    this._socketHandle = null;
    await super.stop();
  }
}
