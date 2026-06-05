// @lazyclaw/channel-discord
//
// discord.js v14 gateway client. Inbound MessageCreate events are routed
// to the lazyclaw daemon's handler; outbound send() posts into the
// channel id resolved from threadId.
//
// In-tree dev import: this file imports from '../channels/base.mjs' so the
// per-plugin test can load it directly without going through node_modules.
// Published packages will rewrite the import to 'lazyclaw/channels/base.mjs'
// via a prepublishOnly script (out of scope for v5.0 plumbing).

import { Channel } from '../channels/base.mjs';

export class DiscordChannel extends Channel {
  constructor(opts = {}) {
    super('discord');
    this._token = opts.token || process.env.DISCORD_BOT_TOKEN || null;
    this._client = null;
    this._lib = null;
  }

  async start(handler, opts = {}) {
    await super.start(handler, opts);
    if (!this._token) throw new Error('DiscordChannel: DISCORD_BOT_TOKEN missing');
    this._lib = await import('discord.js');
    const { Client, GatewayIntentBits, Partials } = this._lib;
    this._client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });
    this._client.on('messageCreate', async (msg) => {
      if (msg.author?.bot) return;
      try {
        const reply = await this._processInbound({
          threadId: String(msg.channelId),
          text: msg.content || '',
          gateInput: { token: msg.author?.id || null },
        });
        if (reply) await msg.channel.send(reply);
      } catch (e) {
        if (e.code !== 'CHANNEL_GATED') {
          process.stderr.write(`[discord] inbound error: ${e.message}\n`);
        }
      }
    });
    await this._client.login(this._token);
  }

  async send(threadId, text) {
    if (!this._client) {
      const err = new Error('CLIENT_NOT_READY');
      err.code = 'CLIENT_NOT_READY';
      throw err;
    }
    const ch = await this._client.channels.fetch(String(threadId));
    if (!ch) throw new Error(`discord channel not found: ${threadId}`);
    await ch.send(text);
  }

  async stop() {
    if (this._client) {
      try { await this._client.destroy(); } catch { /* ignore */ }
    }
    this._client = null;
    await super.stop();
  }
}

export function register({ addChannel }) {
  addChannel('discord', (opts) => new DiscordChannel(opts));
}
