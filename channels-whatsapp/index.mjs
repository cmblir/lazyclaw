// @lazyclaw/channel-whatsapp
//
// whatsapp-web.js (browser automation). First-run prints a QR via
// qrcode-terminal; subsequent runs reuse LocalAuth session in
// <configDir>/whatsapp/. Inbound `message` events route to handler.

import { Channel } from '../channels/base.mjs';

export class WhatsappChannel extends Channel {
  constructor(opts = {}) {
    super('whatsapp');
    this._opts = opts || {};
    this._loadDep = typeof opts.loadDep === 'function' ? opts.loadDep : ((s) => import(s));
    this._client = null;
    this._qrState = 'pending'; // pending | shown | authenticated | failed
    this._lastQr = null;
  }

  qrState() { return this._qrState; }
  lastQr() { return this._lastQr; }

  async start(handler, opts = {}) {
    await super.start(handler, opts);
    const wweb = await this._loadDep('whatsapp-web.js');
    const qrt = await this._loadDep('qrcode-terminal');
    const { Client, LocalAuth } = wweb;
    this._client = new Client({
      authStrategy: new LocalAuth({ dataPath: this._opts.dataPath || './whatsapp' }),
      puppeteer: { headless: true },
    });
    this._client.on('qr', (qr) => {
      this._lastQr = qr;
      this._qrState = 'shown';
      qrt.default?.generate(qr, { small: true });
    });
    this._client.on('authenticated', () => { this._qrState = 'authenticated'; });
    this._client.on('auth_failure', () => { this._qrState = 'failed'; });
    this._client.on('message', async (msg) => {
      try {
        const reply = await this._processInbound({
          threadId: msg.from, text: msg.body || '', gateInput: { token: msg.from },
        });
        if (reply) await msg.reply(reply);
      } catch (e) {
        if (e.code !== 'CHANNEL_GATED') {
          process.stderr.write(`[whatsapp] inbound error: ${e.message}\n`);
        }
      }
    });
    await this._client.initialize();
  }

  async send(threadId, text) {
    if (!this._client || this._qrState !== 'authenticated') {
      const err = new Error('NOT_AUTHENTICATED');
      err.code = 'NOT_AUTHENTICATED';
      throw err;
    }
    await this._client.sendMessage(String(threadId), String(text));
  }

  async stop() {
    if (this._client) { try { await this._client.destroy(); } catch { /* ignore */ } }
    this._client = null;
    await super.stop();
  }
}

export function register({ addChannel }) {
  addChannel('whatsapp', (opts) => new WhatsappChannel(opts));
}
