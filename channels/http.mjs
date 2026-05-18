// HTTP channel adapter.
//
// Phase 7 introduces a Channel abstraction but does NOT relocate the
// existing daemon's HTTP routing — that surface is large (POST /agent,
// /chat, /sessions, /workflows, /skills, the dashboard SPA …) and a
// byte-identical refactor is high-risk. Instead, this adapter wraps
// daemon.mjs.startDaemon so callers that want a uniform Channel handle
// (start/send/stop) get one, while the regression path (`lazyclaw
// daemon` with no --channels flag) stays untouched.
//
// `send(threadId, text)` is a no-op for HTTP: the daemon's response is
// streamed back synchronously via SSE on the original request, not via
// a separate push. The method exists for interface conformance.

import { Channel } from './base.mjs';

export class HttpChannel extends Channel {
  constructor(opts = {}) {
    super('http');
    this._opts = opts;
    this._daemon = null;
  }

  async start(handler, opts = {}) {
    await super.start(handler, opts);
    // Lazy import so a `--channels stub` setup doesn't pay the cost of
    // pulling in the full daemon module.
    const { startDaemon } = await import('../daemon.mjs');
    this._daemon = await startDaemon({
      ...this._opts,
      // The handler the daemon owns is unchanged — it talks to providers
      // through ctx.readConfig/providersMod. We're just standing the
      // existing daemon up under the channel interface so a future
      // unified runtime can speak HTTP through the same `Channel` shape.
    });
    return this._daemon;
  }

  async send(_threadId, _text) {
    // HTTP replies are streamed in-line on the original request handler
    // (SSE chunks for POST /agent). Nothing to push.
  }

  get port() { return this._daemon?.port ?? this._opts.port ?? null; }
  get url()  { return this._daemon?.url  ?? null; }

  async stop() {
    if (this._daemon && typeof this._daemon.close === 'function') {
      await this._daemon.close();
    }
    this._daemon = null;
    await super.stop();
  }
}
