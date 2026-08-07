// Matrix channel adapter.
//
// Speaks the Matrix client-server HTTP API directly — no SDK dependency,
// mirroring Telegram's getUpdates long-poll discipline. Two secrets are
// read from the constructor or the environment ONLY (never from goal
// files, never logged):
//   MATRIX_HOMESERVER    https://matrix.org — the homeserver base URL
//   MATRIX_ACCESS_TOKEN  syt_…             — bearer token for every call
//
// Inbound arrives via long-poll `GET /_matrix/client/v3/sync`: the request
// is held open up to `timeout` ms; when room timeline events arrive we
// route every `m.room.message` of `msgtype: m.text` through
// `_simulateInbound(syncResponse)`, which calls
// `handler({ channel:'matrix', threadId:'matrix:<roomId>', text, senderId })`
// and posts the reply with `send()`. The `since` token is advanced from the
// sync response's `next_batch` ONLY after the batch is processed without
// throwing, so a failed reply isn't silently dropped (mirrors Telegram's
// _processBatch offset-after-success discipline).
//
// Outbound (`send(threadId, text)`) issues
// `PUT /_matrix/client/v3/rooms/<roomId>/send/m.room.message/<txnId>` with a
// unique counter-based txnId so the homeserver doesn't dedupe distinct
// replies.
//
// `start({ poll: false })` validates credentials and registers the handler
// without bringing up the poll loop, so unit tests can drive
// `_simulateInbound` / `send` directly. The default poll path is intended to
// be driven by a `matrix listen` subcommand (mirrors `telegram listen`).
//
// LAZYCLAW_MATRIX_API_BASE (or opts.apiBase) overrides the API base URL so
// the Phase 30 spec can point the adapter at a local mock HTTP server. When
// unset it defaults to the homeserver.

import { Channel, ChannelGated } from './base.mjs';

const THREAD_PREFIX = 'matrix';
// Server-side long-poll window for /sync (milliseconds). The homeserver
// holds the request open up to this long when no events are pending, so an
// idle bot makes ~1 request per LONG_POLL_MS instead of spinning.
const LONG_POLL_MS = 30000;

export class MatrixError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MatrixError';
    this.code = code || 'MATRIX_ERR';
  }
}

// Resolve credentials + base URLs, preferring an explicit override, then
// the env. Trailing slashes are trimmed so paths join cleanly. apiBase
// defaults to the homeserver when neither override nor env is set.
export function readMatrixEnv(env = process.env) {
  return {
    homeserver: env.MATRIX_HOMESERVER || null,
    accessToken: env.MATRIX_ACCESS_TOKEN || null,
    userId: env.MATRIX_USER_ID || null,
    apiBase: env.LAZYCLAW_MATRIX_API_BASE || null,
  };
}

// Extract the routable text messages from a parsed /sync response. Walks
// `rooms.join.<roomId>.timeline.events`, keeps only `m.room.message` events
// whose `content.msgtype` is `m.text`, and returns one normalized event per
// message. Returns [] for any shape we don't handle so callers can skip
// without special-casing. Kept as a pure export so the filter is unit
// testable without a transport.
export function extractMessageEvents(syncResponse) {
  if (!syncResponse || typeof syncResponse !== 'object') return [];
  const join = syncResponse.rooms && syncResponse.rooms.join;
  if (!join || typeof join !== 'object') return [];
  const out = [];
  for (const roomId of Object.keys(join)) {
    const room = join[roomId];
    const events = room && room.timeline && Array.isArray(room.timeline.events)
      ? room.timeline.events
      : [];
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      if (ev.type !== 'm.room.message') continue;
      const content = ev.content;
      if (!content || typeof content !== 'object') continue;
      if (content.msgtype !== 'm.text') continue;
      const text = typeof content.body === 'string' ? content.body : '';
      const senderId = ev.sender != null ? String(ev.sender) : null;
      out.push({
        roomId,
        text,
        senderId,
        eventId: ev.event_id != null ? String(ev.event_id) : null,
        threadId: `${THREAD_PREFIX}:${roomId}`,
      });
    }
  }
  return out;
}

export class MatrixChannel extends Channel {
  constructor(opts = {}) {
    super('matrix');
    this._env = { ...readMatrixEnv(), ...opts };
    // apiBase falls back to the homeserver when no override is supplied.
    if (!this._env.apiBase) this._env.apiBase = this._env.homeserver;
    // A pairing allowlist of Matrix user ids (strings). When set, only
    // senders on the list reach the handler; everything else is dropped
    // silently (no handler call, no reply leak to an unpaired room).
    const allow = opts.allowlist || opts.allowedSenders || null;
    this._allowlist = Array.isArray(allow) ? new Set(allow.map((id) => String(id))) : null;
    this._pollHandle = null;     // { stop() } once the loop is running
    this._since = opts.since || null; // /sync batch cursor
    this._txnCounter = 0;        // monotonic txnId source (deterministic-friendly)
    this._inflight = null;       // AbortController for the held-open /sync
    // Per-event dedup: when a mid-batch send fails we leave `since`
    // un-advanced and the homeserver re-delivers the WHOLE batch, so we
    // remember already-handled event ids (bounded, FIFO-evicted) to avoid
    // re-replying to events that already got a reply.
    this._seen = new Set();
    this._seenOrder = [];
    this._seenCap = 2000;
    // Diagnostic sink. Defaults to a no-op until start() wires one up so
    // _simulateInbound can log internal errors without leaking them to the
    // room. Replaced (never appended) on every start().
    this._logger = () => {};
  }

  // Begin accepting messages. With the default `poll: true` this spins up
  // the long-poll loop; tests pass `poll: false` to keep the adapter pure
  // and drive `_simulateInbound` / `send` directly.
  //
  // opts (beyond the base gate):
  //   poll?: boolean          — start the /sync loop (default true)
  //   since?: string          — initial sync cursor (default none → full sync)
  //   timeoutMs?: number      — server-side long-poll window (default 30000)
  //   logger?: (line) => void — diagnostic sink (stderr in CLI, no-op in tests)
  async start(handler, opts = {}) {
    if (!this._env.accessToken) {
      throw new MatrixError(
        'cannot start Matrix channel without an access token — set MATRIX_ACCESS_TOKEN or pass { accessToken }',
        'MATRIX_MISSING_TOKEN'
      );
    }
    // The homeserver identifies the bot's domain and is required even when
    // an explicit apiBase override (test mock) supplies the transport host.
    if (!this._env.homeserver) {
      throw new MatrixError(
        'cannot start Matrix channel without a homeserver — set MATRIX_HOMESERVER or pass { homeserver }',
        'MATRIX_MISSING_HOMESERVER'
      );
    }
    if (!this._env.apiBase) {
      throw new MatrixError(
        'cannot resolve a Matrix API base URL — set MATRIX_HOMESERVER, LAZYCLAW_MATRIX_API_BASE, or pass { apiBase }',
        'MATRIX_MISSING_API_BASE'
      );
    }
    await super.start(handler, opts);
    this._logger = typeof opts.logger === 'function' ? opts.logger : () => {};
    if (typeof opts.since === 'string') this._since = opts.since;
    this._timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : LONG_POLL_MS;
    const poll = opts.poll !== false; // default true
    if (poll) this._startPollLoop({ logger: this._logger, onDead: opts.onDead });
    return this;
  }

  // Called by the poll loop (or tests) for each parsed /sync response. Walks
  // the room timelines, enforces the self-filter + pairing allowlist, calls
  // the handler per text message, and posts the reply back to the
  // originating room. A null / empty-string reply skips the send entirely so
  // a handler that decides to stay silent doesn't leak a placeholder. Throws
  // if any send() throws so the caller can decline to advance the `since`
  // cursor (mirrors Telegram's _processBatch).
  async _simulateInbound(syncResponse) {
    const events = extractMessageEvents(syncResponse);
    for (const evt of events) {
      // Already handled in a prior (re-delivered) batch → don't re-reply.
      if (evt.eventId && this._seen.has(evt.eventId)) continue;
      // Never reply to ourselves — that's an infinite loop. (Not marked
      // seen: a no-op skip is cheap to re-evaluate, and marking it could
      // mask a genuinely different later event.)
      if (this._env.userId && evt.senderId === String(this._env.userId)) continue;
      // Not paired — drop silently. We deliberately do NOT reply so an
      // unknown room can't be used to probe the bot. (Also not marked seen
      // — re-evaluating is a cheap no-op with no side effect.)
      if (this._allowlist && (!evt.senderId || !this._allowlist.has(evt.senderId))) continue;

      let reply;
      try {
        reply = await this._processInbound({
          threadId: evt.threadId,
          text: evt.text,
          // base.mjs's bucket gate reads req.token || req.key, so the sender
          // id rides under `key`: an authToken gate compares against it and a
          // rate-limit gate keys per-sender. We keep senderId for downstream
          // handler context, and the globally-unique event_id for daemon-
          // side dedup.
          gateInput: { key: evt.senderId, senderId: evt.senderId, messageId: evt.eventId },
        });
      } catch (err) {
        if (err instanceof ChannelGated || err?.code === 'CHANNEL_GATED') {
          // A gate denial is an expected, user-facing condition; the reason
          // ('rate_limited' / 'unauthorized') is safe to surface.
          await this.send(evt.threadId, `(gated: ${err.message})`);
          this._markSeen(evt.eventId);
          continue;
        }
        // An unexpected handler/transport error may carry internal detail
        // (stack, secrets in messages). Reply a generic notice to the room
        // and log the full error to the diagnostic sink only.
        this._logger(`[matrix] handler error: ${err?.stack || err?.message || err}\n`);
        try {
          await this.send(evt.threadId, '(internal error)');
        } catch (sendErr) {
          this._logger(`[matrix] failed to deliver error notice: ${sendErr?.message || sendErr}\n`);
        }
        this._markSeen(evt.eventId);
        continue;
      }
      if (reply == null || (typeof reply === 'string' && reply.trim() === '')) { this._markSeen(evt.eventId); continue; }
      // If this send throws, the event is left UNSEEN so the re-delivered
      // batch retries it (while already-replied events above are skipped).
      await this.send(evt.threadId, reply);
      this._markSeen(evt.eventId);
    }
  }

  // Remember a handled event id, FIFO-evicting beyond the cap so the set
  // can't grow without bound on a long-lived listener.
  _markSeen(eventId) {
    if (!eventId || this._seen.has(eventId)) return;
    this._seen.add(eventId);
    this._seenOrder.push(eventId);
    if (this._seenOrder.length > this._seenCap) {
      const old = this._seenOrder.shift();
      this._seen.delete(old);
    }
  }

  // The base _processInbound forwards { channel, threadId, text }; we enrich
  // the event the router sees with senderId so memory / pairing hooks
  // downstream can key on the human. Override stays in lockstep with
  // base.mjs's contract — it only adds fields, never drops them.
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

  // Deliver a reply. threadId encodes the room as `matrix:<roomId>` (the
  // shape extractMessageEvents emits); a bare room id is also accepted so
  // callers can address a room directly.
  async send(threadId, text, _opts = {}) {
    if (!this._env.accessToken) throw new MatrixError('cannot send without a Matrix access token', 'MATRIX_NO_TOKEN');
    const roomId = this._decodeRoomId(threadId);
    if (!roomId) throw new MatrixError(`cannot resolve roomId from threadId "${threadId}"`, 'MATRIX_BAD_THREAD');
    const txnId = this._nextTxnId();
    const base = String(this._env.apiBase).replace(/\/$/, '');
    const url = `${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`;
    const body = { msgtype: 'm.text', body: String(text) };
    let res;
    try {
      res = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this._env.accessToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new MatrixError(`matrix send transport error: ${err?.message || err}`, 'MATRIX_TRANSPORT');
    }
    if (!res.ok) {
      throw new MatrixError(`matrix send failed: HTTP ${res.status}`, 'MATRIX_HTTP_FAIL');
    }
    const json = await res.json().catch(() => ({}));
    if (json && json.errcode) {
      throw new MatrixError(`matrix send failed: ${json.error || json.errcode}`, 'MATRIX_API_FAIL');
    }
    return json;
  }

  // Translate a `matrix:<roomId>` threadId (or a bare room id) into a room
  // id string. Room ids contain a ':' (e.g. !abc:example), so we only strip
  // the leading `matrix:` prefix — never split on the first ':'.
  _decodeRoomId(threadId) {
    if (threadId == null) return null;
    const s = String(threadId);
    if (s.startsWith(`${THREAD_PREFIX}:`)) {
      const rest = s.slice(THREAD_PREFIX.length + 1);
      return rest || null;
    }
    return s || null;
  }

  // Monotonic, deterministic-friendly transaction id. The homeserver dedupes
  // PUT /send retries by (room, txnId), so each distinct reply needs its own
  // id. We seed with the process start time so a restarted daemon doesn't
  // collide with a previous run's low counters.
  _nextTxnId() {
    this._txnCounter += 1;
    return `pompos-${this._txnCounter}-${Date.now()}`;
  }

  // Spin up the long-poll loop. Each iteration issues a single held-open
  // /sync; the held-open request is what paces the idle loop (no per-turn
  // sleep). The batch is handed to _simulateInbound which throws if a reply
  // fails to deliver, in which case we leave `since` un-advanced so the
  // homeserver re-delivers on the next poll. Errors are logged and the loop
  // backs off rather than crashing the daemon. The in-flight AbortController
  // is held so stop() can abort the ~30s held-open request for prompt
  // shutdown.
  _startPollLoop({ logger, onDead }) {
    let stopped = false;
    // Abnormal loop death must be VISIBLE to a live process: a gateway whose
    // matrix poll silently exits looks healthy while being deaf on that
    // channel. Default: throw from a fresh tick so the process crash
    // handlers fire (and a service manager restarts it).
    const dead = (err) => {
      if (typeof onDead === 'function') return onDead(err);
      setImmediate(() => { throw err; });
    };
    const loop = async () => {
      while (!stopped) {
        try {
          const sync = await this._fetchSync(() => stopped);
          if (stopped) break;
          if (sync) {
            await this._simulateInbound(sync);
            // Advance the cursor ONLY after the batch processed without
            // throwing, so a failed send isn't silently acked away.
            if (sync.next_batch != null) this._since = sync.next_batch;
          }
        } catch (err) {
          if (stopped) break;
          if (err?.name === 'AbortError' || err?.code === 'MATRIX_ABORTED') {
            // Aborted while NOT stopping = some other actor killed the
            // in-flight sync — that's a dead listener, not a clean exit.
            logger(`[matrix] sync aborted outside shutdown — stopping listener\n`);
            this._fatal = err;
            dead(err);
            break;
          }
          // A dead/forbidden token will never recover — stop the listener
          // and surface it rather than spinning forever on a 500ms back-off.
          if (err?.code === 'MATRIX_AUTH_FATAL') {
            logger(`[matrix] FATAL: ${err.message} — stopping listener\n`);
            this._fatal = err;
            dead(err);
            break;
          }
          logger(`[matrix] poll error: ${err?.message || err}\n`);
          // Back off a beat so we don't spin hot against a failing endpoint.
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    };
    const promise = loop();
    this._pollHandle = {
      stop: async () => {
        stopped = true;
        // Abort the held-open /sync so shutdown doesn't block ~30s.
        try { this._inflight?.abort(); } catch { /* best-effort */ }
        try { await promise; } catch { /* best-effort */ }
      },
    };
  }

  // One /sync call. Uses the homeserver's server-side long-poll (timeout in
  // ms) so an idle bot holds a single request open. The held-open request's
  // AbortController is stashed in `this._inflight` so stop() can cut it
  // short. Returns the parsed sync response (or null when aborted mid-flight
  // during shutdown). Kept separate from the loop so it stays unit-testable.
  async _fetchSync(isStopped = () => false) {
    const base = String(this._env.apiBase).replace(/\/$/, '');
    const params = new URLSearchParams();
    if (this._since) params.set('since', this._since);
    params.set('timeout', String(this._timeoutMs ?? LONG_POLL_MS));
    const url = `${base}/_matrix/client/v3/sync?${params.toString()}`;
    const controller = new AbortController();
    this._inflight = controller;
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this._env.accessToken}` },
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        if (isStopped()) return null;
        const e = new MatrixError('matrix sync aborted', 'MATRIX_ABORTED');
        throw e;
      }
      throw new MatrixError(`matrix sync transport error: ${err?.message || err}`, 'MATRIX_TRANSPORT');
    } finally {
      this._inflight = null;
    }
    if (!res.ok) {
      // 401/403 mean the access token is dead/forbidden — retrying forever
      // is pointless. Mark it fatal so the loop stops and surfaces instead
      // of spinning on a 500ms back-off against a revoked credential.
      if (res.status === 401 || res.status === 403) {
        throw new MatrixError(`matrix sync auth failed: HTTP ${res.status} (check MATRIX_ACCESS_TOKEN)`, 'MATRIX_AUTH_FATAL');
      }
      throw new MatrixError(`matrix sync failed: HTTP ${res.status}`, 'MATRIX_HTTP_FAIL');
    }
    const json = await res.json().catch(() => ({}));
    return json && typeof json === 'object' ? json : {};
  }

  async stop() {
    if (this._pollHandle && typeof this._pollHandle.stop === 'function') {
      try { await this._pollHandle.stop(); } catch { /* best-effort */ }
    }
    this._pollHandle = null;
    // Defensive: abort any straggling in-flight request even if the loop
    // wasn't running (e.g. a bare _fetchSync was driven by a test).
    try { this._inflight?.abort(); } catch { /* best-effort */ }
    this._inflight = null;
    await super.stop();
  }
}
