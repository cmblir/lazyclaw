// In-memory channel used for tests and for any caller that wants to
// drive the daemon without a real transport. `inbox.push({ threadId,
// text, token? })` triggers the handler; replies land in `outbox`.
//
// The stub respects the same gate object the HTTP channel uses so
// auth-token + rate-limit assertions on the daemon's middleware chain
// can be exercised without round-tripping through TCP.

import { Channel } from './base.mjs';

export class StubChannel extends Channel {
  constructor() {
    super('stub');
    /** @type {Array<{ threadId: string, text: string, token?: string|null, key?: string|null }>} */
    this.inbox = [];
    /** @type {Array<{ threadId: string, text: string, error?: string }>} */
    this.outbox = [];
    this._pump = null;
  }

  async start(handler, opts = {}) {
    await super.start(handler, opts);
    this._pump = setInterval(() => this._drain(), 5);
    // unref so a hanging interval doesn't keep the process alive
    if (typeof this._pump.unref === 'function') this._pump.unref();
  }

  async _drain() {
    while (this.inbox.length) {
      const item = this.inbox.shift();
      try {
        const reply = await this._processInbound({
          threadId: item.threadId,
          text: item.text,
          gateInput: { token: item.token, key: item.key },
        });
        this.outbox.push({ threadId: item.threadId, text: String(reply) });
      } catch (err) {
        this.outbox.push({ threadId: item.threadId, text: '', error: err?.message || String(err), code: err?.code });
      }
    }
  }

  async send(threadId, text) {
    this.outbox.push({ threadId, text: String(text) });
  }

  async stop() {
    if (this._pump) { clearInterval(this._pump); this._pump = null; }
    await super.stop();
  }
}
