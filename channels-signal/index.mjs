// @lazyclaw/channel-signal
//
// Thin wrapper around `signal-cli` (external binary, must be installed
// separately and linked to a registered account). Inbound polling uses
// `signal-cli receive --json`; outbound uses `signal-cli send`.

import { spawn, spawnSync } from 'node:child_process';
import { Channel } from '../channels/base.mjs';

export class SignalChannel extends Channel {
  constructor(opts = {}) {
    super('signal');
    this._binary = opts.binary || process.env.SIGNAL_CLI_BIN || 'signal-cli';
    this._account = opts.account || process.env.SIGNAL_ACCOUNT || null;
    this._receiver = null;
    this._pollMs = opts.pollMs || 15000;
  }

  async start(handler, opts = {}) {
    await super.start(handler, opts);
    if (!this._account) throw new Error('SignalChannel: account (E.164) required');
    this._receiver = setInterval(() => { this._pollOnce().catch(() => {}); }, this._pollMs);
    this._receiver.unref?.();
  }

  async _pollOnce() {
    const proc = spawn(this._binary, ['-a', this._account, 'receive', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    proc.stdout.on('data', (d) => { buf += d.toString('utf8'); });
    await new Promise((resolve) => proc.on('exit', resolve));
    for (const line of buf.split('\n')) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        const env = evt.envelope || {};
        const text = env.dataMessage?.message || '';
        const from = env.source || env.sourceNumber;
        if (!from || !text) continue;
        const reply = await this._processInbound({
          threadId: String(from), text, gateInput: { token: from },
        });
        if (reply) await this.send(from, reply);
      } catch { /* skip malformed */ }
    }
  }

  async send(threadId, text) {
    const res = spawnSync(this._binary, ['-a', this._account, 'send', '-m', String(text), String(threadId)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    if (res.error && res.error.code === 'ENOENT') {
      const err = new Error(`SIGNAL_CLI_MISSING: ${this._binary}`);
      err.code = 'SIGNAL_CLI_MISSING';
      throw err;
    }
    if (res.status !== 0) {
      throw new Error(`signal-cli send exited ${res.status}: ${res.stderr?.toString('utf8') || ''}`);
    }
  }

  async stop() {
    if (this._receiver) clearInterval(this._receiver);
    this._receiver = null;
    await super.stop();
  }
}

export function register({ addChannel }) {
  addChannel('signal', (opts) => new SignalChannel(opts));
}
