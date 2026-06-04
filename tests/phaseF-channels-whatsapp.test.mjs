import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { Channel } from '../channels/base.mjs';

const entry = pathToFileURL(path.join(process.cwd(), 'channels-whatsapp', 'index.mjs')).href;

test('whatsapp: register + Channel subclass + QR-pending state', async () => {
  const mod = await import(entry);
  assert.equal(typeof mod.register, 'function');
  const ch = new mod.WhatsappChannel();
  assert.ok(ch instanceof Channel);
  assert.equal(ch.name, 'whatsapp');
  assert.equal(ch.qrState(), 'pending');
});

test('whatsapp: send() before login throws NOT_AUTHENTICATED', async () => {
  const mod = await import(entry);
  const ch = new mod.WhatsappChannel();
  await assert.rejects(ch.send('+15551234567', 'hi'), /NOT_AUTHENTICATED/);
});
