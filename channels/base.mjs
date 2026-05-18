// Abstract base for a daemon channel.
//
// A Channel owns a transport (HTTP, Slack Socket Mode, in-memory stub, …).
// It calls `handler({ channel, threadId, text })` once per inbound message
// and emits the resolved reply through `send(threadId, text)`.
//
// Cross-cutting concerns (auth, rate-limit, allowed-origin, audit) live
// outside the channel itself: when a Channel wants to apply them, it
// calls `applyGate(req)` first. Concrete subclasses pass the gate object
// down at start time so every channel runs the same middleware chain
// that today's HTTP daemon enforces on `POST /agent`.

export class Channel {
  constructor(name) {
    this.name = String(name || 'unnamed');
    /** @type {((evt: { channel: string, threadId: string, text: string }) => Promise<string>) | null} */
    this._handler = null;
    /** @type {{ check: (req: { token?: string|null, key?: string|null }) => { ok: boolean, reason?: string } } | null} */
    this._gate = null;
    this._started = false;
  }

  /**
   * Begin accepting messages. The concrete subclass starts its transport
   * here (e.g. createServer + listen for HTTP, Socket Mode for Slack,
   * nothing for the stub). Must be safe to call once per instance.
   *
   * @param {(evt: { channel: string, threadId: string, text: string }) => Promise<string>} handler
   * @param {{ gate?: { check: (req: any) => { ok: boolean, reason?: string } } }} [opts]
   */
  async start(handler, opts = {}) {
    if (this._started) throw new Error(`channel "${this.name}" already started`);
    this._handler = handler;
    this._gate = opts.gate || null;
    this._started = true;
  }

  /**
   * Deliver a reply to the caller identified by threadId. The shape of
   * threadId is channel-specific (a Slack channel/thread, a stub inbox
   * key, an HTTP request id). Subclasses override.
   *
   * @param {string} threadId
   * @param {string} text
   */
  async send(_threadId, _text) {
    throw new Error(`${this.constructor.name}.send() not implemented`);
  }

  /**
   * Tear down the transport. Must be idempotent — channel managers call
   * this on every channel during shutdown without first checking whether
   * the channel ever started.
   */
  async stop() {
    this._started = false;
    this._handler = null;
    this._gate = null;
  }

  /**
   * Subclasses call this from their inbound paths before invoking the
   * handler. Returns the handler's reply on success, throws ChannelGated
   * on auth/rate-limit denial.
   */
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
    return await this._handler({ channel: this.name, threadId, text });
  }
}

export class ChannelGated extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ChannelGated';
    this.code = code || 'CHANNEL_GATED';
  }
}

// Tiny token-bucket gate used by stub + slack channels. The HTTP channel
// continues to use daemon.mjs's in-tree limiter so the regression path
// is byte-identical.
export function makeBucketGate({ authToken = null, rateLimit = null } = {}) {
  const limiter = rateLimit
    ? makeTokenBucket(rateLimit.capacity ?? 20, rateLimit.refillPerSec ?? 1)
    : null;
  return {
    check(req) {
      if (authToken) {
        const presented = req.token || req.key || null;
        if (!presented || presented !== authToken) return { ok: false, reason: 'unauthorized' };
      }
      if (limiter && !limiter.take(1)) return { ok: false, reason: 'rate_limited' };
      return { ok: true };
    },
  };
}

function makeTokenBucket(capacity, refillPerSec) {
  let tokens = capacity;
  let last = Date.now();
  return {
    take(n) {
      const now = Date.now();
      const elapsed = (now - last) / 1000;
      tokens = Math.min(capacity, tokens + elapsed * refillPerSec);
      last = now;
      if (tokens >= n) { tokens -= n; return true; }
      return false;
    },
  };
}
