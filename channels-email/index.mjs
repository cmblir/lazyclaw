// @pompos/channel-email
//
// IMAP IDLE for inbound, nodemailer for outbound. threadId is the
// In-Reply-To / Message-ID chain root so replies stay in the same
// email thread.

import { Channel } from '../channels/base.mjs';

export class EmailChannel extends Channel {
  constructor(opts = {}) {
    super('email');
    if (!opts.imap || !opts.imap.user || !opts.imap.host) {
      throw new Error('IMAP_CONFIG_MISSING: imap.{user,host,password,port,tls} required');
    }
    this._imapOpts = opts.imap;
    this._smtpOpts = opts.smtp || {};
    this._from = opts.from || opts.imap.user;
    this._loadDep = typeof opts.loadDep === 'function' ? opts.loadDep : ((s) => import(s));
    this._imap = null;
    this._transporter = null;
  }

  async start(handler, opts = {}) {
    await super.start(handler, opts);
    const Imap = (await this._loadDep('node-imap')).default;
    const { simpleParser } = await this._loadDep('mailparser');
    const nodemailer = (await this._loadDep('nodemailer')).default;

    this._transporter = nodemailer.createTransport({
      host: this._smtpOpts.host,
      port: this._smtpOpts.port || 587,
      secure: !!this._smtpOpts.secure,
      auth: this._smtpOpts.user ? { user: this._smtpOpts.user, pass: this._smtpOpts.pass } : undefined,
    });

    this._imap = new Imap({
      user: this._imapOpts.user,
      password: this._imapOpts.password,
      host: this._imapOpts.host,
      port: this._imapOpts.port || 993,
      tls: this._imapOpts.tls !== false,
    });

    await new Promise((resolve, reject) => {
      this._imap.once('ready', resolve);
      this._imap.once('error', reject);
      this._imap.connect();
    });
    await new Promise((resolve, reject) => {
      this._imap.openBox('INBOX', false, (err) => err ? reject(err) : resolve());
    });

    this._imap.on('mail', () => {
      this._imap.search(['UNSEEN'], (err, uids) => {
        if (err || !uids || !uids.length) return;
        const f = this._imap.fetch(uids, { bodies: '', markSeen: true });
        f.on('message', (msg) => {
          let chunks = [];
          msg.on('body', (s) => s.on('data', (d) => chunks.push(d)));
          msg.once('end', async () => {
            try {
              const parsed = await simpleParser(Buffer.concat(chunks));
              const threadId = parsed.inReplyTo || parsed.messageId || `email:${Date.now()}`;
              const from = parsed.from?.value?.[0]?.address || 'unknown';
              const reply = await this._processInbound({
                threadId, text: parsed.text || '', gateInput: { token: from },
              });
              if (reply) {
                await this._transporter.sendMail({
                  from: this._from, to: from,
                  subject: 'Re: ' + (parsed.subject || ''),
                  text: reply,
                  inReplyTo: parsed.messageId,
                  references: parsed.references || parsed.messageId,
                });
              }
            } catch (e) {
              if (e.code !== 'CHANNEL_GATED') {
                process.stderr.write(`[email] inbound error: ${e.message}\n`);
              }
            }
          });
        });
      });
    });
  }

  async send(threadId, text) {
    if (!this._transporter) {
      const err = new Error('SMTP_NOT_READY');
      err.code = 'SMTP_NOT_READY';
      throw err;
    }
    // threadId here is the recipient address; the daemon supplies it.
    await this._transporter.sendMail({
      from: this._from, to: String(threadId), subject: 'pompos', text: String(text),
    });
  }

  async stop() {
    try { this._imap?.end(); } catch { /* ignore */ }
    this._imap = null;
    this._transporter = null;
    await super.stop();
  }
}

export function register({ addChannel }) {
  addChannel('email', (opts) => new EmailChannel(opts));
}
