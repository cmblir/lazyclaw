// Telegram channel adapter.
//
// Reads one secret from the constructor or the environment ONLY (never
// from goal files, never logged):
//   TELEGRAM_BOT_TOKEN  123456:ABC-… — used both to address every Bot
//                                      API method and to authorize calls.
//
// The Bot API addresses methods by embedding the token in the path:
//   https://api.telegram.org/bot<TOKEN>/<method>
// so a single token covers both inbound (getUpdates long-poll) and
// outbound (sendMessage). Outbound (`send(threadId, text)`) only needs
// that token. Inbound arrives via long-polling — `start()` (with the
// default `poll: true`) spins up `_pollLoop()` which calls `getUpdates`
// and funnels every message through `_simulateInbound(update)`.
//
// `start({ poll: false })` validates the token and registers the handler
// without bringing up the poll loop, so unit tests can drive
// `_simulateInbound` / `send` directly. The default poll path is intended
// to be driven by a future `telegram listen` subcommand (not yet wired in
// the CLI).
//
// LAZYCLAW_TELEGRAM_API_BASE (or opts.apiBase) overrides the Bot API
// base URL so the Phase 21 spec can point the adapter at a local mock
// HTTP server.

import { Channel, ChannelGated } from './base.mjs';

const DEFAULT_API_BASE = 'https://api.telegram.org';
const THREAD_PREFIX = 'telegram';
// Server-side long-poll window for getUpdates (seconds). Telegram holds
// the request open up to this long when no updates are pending, so an
// idle bot makes ~1 request per LONG_POLL_SECONDS instead of spinning.
const LONG_POLL_SECONDS = 50;

export class TelegramError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TelegramError';
    this.code = code || 'TELEGRAM_ERR';
  }
}

// Resolve the Bot API base URL, preferring an explicit override, then
// the env, then the public default. Trailing slashes are trimmed so we
// can join paths without doubling separators.
export function readTelegramEnv(env = process.env) {
  return {
    token: env.TELEGRAM_BOT_TOKEN || null,
    apiBase: env.LAZYCLAW_TELEGRAM_API_BASE || DEFAULT_API_BASE,
  };
}

// Normalize a raw Telegram update into the channel event shape the
// router consumes. Returns null for updates we don't handle (no text,
// no chat) so the caller can skip them without special-casing.
//
// Telegram delivers several message containers (message, edited_message,
// channel_post, edited_channel_post); we accept the first one present so
// edits and channel posts route the same way as fresh DMs.
export function normalizeUpdate(update) {
  if (!update || typeof update !== 'object') return null;
  const msg =
    update.message ||
    update.edited_message ||
    update.channel_post ||
    update.edited_channel_post ||
    null;
  if (!msg || typeof msg !== 'object') return null;
  const text = typeof msg.text === 'string' ? msg.text : '';
  const chatId = msg.chat && msg.chat.id != null ? String(msg.chat.id) : null;
  if (!chatId) return null;
  const senderId = msg.from && msg.from.id != null ? String(msg.from.id) : null;
  return {
    text,
    chatId,
    senderId,
    messageId: msg.message_id != null ? String(msg.message_id) : null,
    updateId: update.update_id != null ? Number(update.update_id) : null,
    // threadId encodes the chat the reply must go back to.
    threadId: `${THREAD_PREFIX}:${chatId}`,
  };
}

export class TelegramChannel extends Channel {
  constructor(opts = {}) {
    super('telegram');
    this._env = { ...readTelegramEnv(), ...opts };
    // A pairing allowlist of Telegram user ids (strings). When set, only
    // senders on the list reach the handler; everything else is dropped
    // silently (no handler call, no reply leak to an unpaired chat).
    const allow = opts.allowlist || opts.allowedSenders || null;
    this._allowlist = Array.isArray(allow) ? new Set(allow.map((id) => String(id))) : null;
    this._pollHandle = null;   // { stop() } once the loop is running
    this._offset = 0;          // getUpdates offset cursor (ack via +1)
    // Diagnostic sink. Defaults to a no-op until start() wires one up so
    // _simulateInbound can log internal errors without leaking them to the
    // chat. Replaced (never appended) on every start().
    this._logger = () => {};
  }

  // Begin accepting messages. With the default `poll: true` this spins
  // up the long-poll loop; tests pass `poll: false` to keep the adapter
  // pure and drive `_simulateInbound` / `send` directly.
  //
  // opts (beyond the base gate):
  //   poll?: boolean          — start the getUpdates loop (default true)
  //   pollIntervalMs?: number — extra backoff between getUpdates calls
  //                             (default 0). The loop already paces itself
  //                             off the held-open ~50s long-poll request,
  //                             so no per-turn sleep is needed when idle;
  //                             this only adds a small inter-poll delay /
  //                             error backoff when set.
  //   logger?: (line) => void — diagnostic sink (stderr in CLI, no-op in tests)
  async start(handler, opts = {}) {
    if (!this._env.token) {
      throw new TelegramError(
        'cannot start Telegram channel without a token — set TELEGRAM_BOT_TOKEN or pass { token }',
        'TELEGRAM_MISSING_TOKEN'
      );
    }
    await super.start(handler, opts);
    // Wire the diagnostic sink regardless of poll mode so _simulateInbound
    // can log internal handler errors (never echoed to the chat).
    this._logger = typeof opts.logger === 'function' ? opts.logger : () => {};
    const poll = opts.poll !== false; // default true
    if (poll) {
      this._startPollLoop({
        // Telegram caps the held-open getUpdates at ~50s; the loop paces
        // itself off that long-poll, so pollIntervalMs is only a small
        // backoff between iterations (default 0 — no extra sleep).
        pollIntervalMs: typeof opts.pollIntervalMs === 'number' ? opts.pollIntervalMs : 0,
        logger: this._logger,
      });
    }
    return this;
  }

  // Called by the poll loop (or tests) for every inbound update routed
  // to this bot. The handler returns the bot's reply; the adapter posts
  // it back to the originating chat. A null / empty-string reply skips
  // the send entirely so a handler that decides to stay silent doesn't
  // leak a placeholder into the chat. Unpaired senders are dropped
  // before the handler runs (no reply, no handler call).
  async _simulateInbound(update) {
    const evt = normalizeUpdate(update);
    if (!evt) return;
    if (this._allowlist && (!evt.senderId || !this._allowlist.has(evt.senderId))) {
      // Not paired — drop silently. We deliberately do NOT reply so an
      // unknown chat can't be used to probe the bot.
      return;
    }
    let reply;
    try {
      reply = await this._processInbound({
        threadId: evt.threadId,
        text: evt.text,
        // base.mjs's bucket gate reads req.token || req.key, so the sender
        // id rides under `key`: an authToken gate compares against it and a
        // rate-limit gate keys per-sender. We also keep senderId for
        // downstream handler context, plus the chat-scoped message id
        // (message_id is only unique per chat) for daemon-side dedup.
        gateInput: {
          key: evt.senderId,
          senderId: evt.senderId,
          messageId: evt.messageId ? `${evt.chatId}:${evt.messageId}` : null,
        },
      });
    } catch (err) {
      if (err instanceof ChannelGated || err?.code === 'CHANNEL_GATED') {
        // A gate denial is an expected, user-facing condition; the reason
        // ('rate_limited' / 'unauthorized') is safe to surface.
        await this.send(evt.threadId, `(gated: ${err.message})`);
        return;
      }
      // An unexpected handler/transport error may carry internal detail
      // (stack, secrets in messages). Reply a generic notice to the chat
      // and log the full error to the diagnostic sink only.
      this._logger(`[telegram] handler error: ${err?.stack || err?.message || err}\n`);
      try {
        await this.send(evt.threadId, '(internal error)');
      } catch (sendErr) {
        this._logger(`[telegram] failed to deliver error notice: ${sendErr?.message || sendErr}\n`);
      }
      return;
    }
    if (reply == null || (typeof reply === 'string' && reply.trim() === '')) return;
    await this.send(evt.threadId, reply);
  }

  // The base _processInbound forwards { channel, threadId, text }; we
  // enrich the event the router sees with senderId so memory / pairing
  // hooks downstream can key on the human. Override stays in lockstep
  // with base.mjs's contract — it only adds fields, never drops them.
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

  // Deliver a reply. threadId encodes the chat as `telegram:<chat_id>`
  // (the shape normalizeUpdate emits); a bare chat id is also accepted
  // so callers can address a chat directly.
  async send(threadId, text, opts = {}) {
    if (!this._env.token) throw new TelegramError('cannot send without a Telegram token', 'TELEGRAM_NO_TOKEN');
    const chatId = this._decodeChatId(threadId);
    if (!chatId) throw new TelegramError(`cannot resolve chat_id from threadId "${threadId}"`, 'TELEGRAM_BAD_THREAD');
    const body = {
      chat_id: chatId,
      text: String(text),
      ...(opts && opts.parse_mode ? { parse_mode: String(opts.parse_mode) } : {}),
      ...(opts && opts.reply_to_message_id ? { reply_to_message_id: opts.reply_to_message_id } : {}),
    };
    const json = await this._apiCall('sendMessage', body);
    return json;
  }

  // Translate a `telegram:<chat_id>` threadId (or a bare chat id) into a
  // Telegram chat_id string. Returns null when nothing usable is found.
  _decodeChatId(threadId) {
    if (threadId == null) return null;
    const s = String(threadId);
    if (s.startsWith(`${THREAD_PREFIX}:`)) {
      const rest = s.slice(THREAD_PREFIX.length + 1);
      return rest || null;
    }
    return s || null;
  }

  // POST a Bot API method. The token lives in the path (`/bot<TOKEN>/<method>`)
  // per the Telegram convention, and the body is JSON. Throws
  // TelegramError on transport or API-level failure.
  //
  // `opts.timeoutMs` aborts the request after the given wall-clock budget.
  // getUpdates passes a budget just above its server-side long-poll
  // (LONG_POLL_SECONDS) so the held-open request isn't cut short, while
  // still bounding a hung connection. Defaults to a short budget for the
  // quick request/response methods (sendMessage, etc.).
  async _apiCall(method, body, opts = {}) {
    const base = String(this._env.apiBase).replace(/\/$/, '');
    const url = `${base}/bot${this._env.token}/${method}`;
    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 15000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body || {}),
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new TelegramError(`telegram ${method} timed out after ${timeoutMs}ms`, 'TELEGRAM_TIMEOUT');
      }
      throw new TelegramError(`telegram ${method} transport error: ${err?.message || err}`, 'TELEGRAM_TRANSPORT');
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new TelegramError(`telegram ${method} failed: HTTP ${res.status}`, 'TELEGRAM_HTTP_FAIL');
    }
    const json = await res.json().catch(() => ({}));
    if (!json || json.ok !== true) {
      throw new TelegramError(`telegram ${method} failed: ${json?.description || 'unknown'}`, 'TELEGRAM_API_FAIL');
    }
    return json;
  }

  // Spin up the long-poll loop. Each iteration issues a single held-open
  // getUpdates (the ~50s server-side long-poll is what paces the idle
  // loop — there is no per-turn sleep unless pollIntervalMs is set), then
  // hands the batch to _processBatch which advances the ack offset only
  // for updates it processes successfully. Errors are logged and the loop
  // backs off rather than crashing the daemon.
  _startPollLoop({ pollIntervalMs, logger }) {
    let stopped = false;
    const loop = async () => {
      while (!stopped) {
        try {
          const updates = await this._fetchUpdates();
          await this._processBatch(updates, () => stopped);
        } catch (err) {
          logger(`[telegram] poll error: ${err?.message || err}\n`);
          // On a transport/API error, back off a beat so we don't spin
          // hot against a failing endpoint even when pollIntervalMs is 0.
          if (!stopped) await new Promise((r) => setTimeout(r, Math.max(pollIntervalMs, 500)));
        }
        if (stopped) break;
        // The held-open long-poll already paces the idle loop; only sleep
        // when the caller asked for an explicit inter-poll delay.
        if (pollIntervalMs > 0) await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
    };
    // Fire and forget — stop() flips `stopped` and the loop exits.
    const promise = loop();
    this._pollHandle = {
      stop: async () => {
        stopped = true;
        try { await promise; } catch { /* best-effort */ }
      },
    };
  }

  // Dispatch one getUpdates batch. The ack offset is advanced ONLY past
  // updates that were processed without throwing: if _simulateInbound
  // throws (e.g. send() fails to deliver the reply), we leave the cursor
  // on that update so Telegram re-delivers it on the next poll instead of
  // silently dropping the reply. Updates within a batch are strictly
  // ordered, so we commit the highest contiguously-succeeded update_id.
  // `isStopped` lets the poll loop bail mid-batch on shutdown.
  async _processBatch(updates, isStopped = () => false) {
    if (!Array.isArray(updates)) return;
    let committed = null; // highest update_id safely processed so far
    for (const update of updates) {
      if (isStopped()) break;
      try {
        await this._simulateInbound(update);
      } catch (err) {
        // Processing failed for this update — do NOT ack it (or anything
        // after it). The loop will re-fetch from the un-advanced offset.
        this._logger(`[telegram] update ${update?.update_id} failed: ${err?.message || err}\n`);
        break;
      }
      const updateId = update && update.update_id != null ? Number(update.update_id) : null;
      if (updateId != null) committed = updateId;
    }
    // Commit the ack only after the batch (or its successful prefix) is
    // done, so a crash mid-batch never advances past unprocessed updates.
    if (committed != null && committed + 1 > this._offset) this._offset = committed + 1;
  }

  // One getUpdates call. Uses Telegram's server-side long-poll (timeout in
  // seconds) so an idle bot holds a single request open instead of
  // hammering the API ~60 req/min. The fetch network timeout is set just
  // above the long-poll so the held-open request isn't aborted early.
  // Returns the array of raw updates (possibly empty). Kept separate from
  // the loop so it stays unit-testable.
  async _fetchUpdates() {
    const json = await this._apiCall(
      'getUpdates',
      { offset: this._offset, timeout: LONG_POLL_SECONDS },
      { timeoutMs: (LONG_POLL_SECONDS + 10) * 1000 }
    );
    return Array.isArray(json.result) ? json.result : [];
  }

  async stop() {
    if (this._pollHandle && typeof this._pollHandle.stop === 'function') {
      try { await this._pollHandle.stop(); } catch { /* best-effort */ }
    }
    this._pollHandle = null;
    await super.stop();
  }
}
