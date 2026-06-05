import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { Channel } from '../channels/base.mjs';

const entry = pathToFileURL(path.join(process.cwd(), 'channels-email', 'index.mjs')).href;

test('email: register + Channel subclass with name "email"', async () => {
  const mod = await import(entry);
  assert.equal(typeof mod.register, 'function');
  const ch = new mod.EmailChannel({
    imap: { user: 'u', password: 'p', host: 'imap.example.com', port: 993, tls: true },
    smtp: { host: 'smtp.example.com', port: 587, user: 'u', pass: 'p' },
  });
  assert.ok(ch instanceof Channel);
  assert.equal(ch.name, 'email');
});

test('email: send() without start throws SMTP_NOT_READY', async () => {
  const mod = await import(entry);
  const ch = new mod.EmailChannel({
    imap: { user: 'u', password: 'p', host: 'h', port: 993, tls: true },
    smtp: { host: 'h', port: 587, user: 'u', pass: 'p' },
  });
  await assert.rejects(ch.send('to@example.com', 'hi'), /SMTP_NOT_READY/);
});

test('email: missing imap config throws IMAP_CONFIG_MISSING', async () => {
  const mod = await import(entry);
  assert.throws(() => new mod.EmailChannel({ smtp: { host: 'h' } }), /IMAP_CONFIG_MISSING/);
});
