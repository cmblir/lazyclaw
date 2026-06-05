import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { Channel } from '../channels/base.mjs';

const entry = pathToFileURL(path.join(process.cwd(), 'channels-signal', 'index.mjs')).href;

test('signal: register + Channel subclass + missing signal-cli surfaces clearly', async () => {
  const mod = await import(entry);
  assert.equal(typeof mod.register, 'function');
  const ch = new mod.SignalChannel({ binary: '/does/not/exist/signal-cli', account: '+15550000000' });
  assert.ok(ch instanceof Channel);
  assert.equal(ch.name, 'signal');
  await assert.rejects(ch.send('+15551234567', 'hi'), /SIGNAL_CLI_MISSING|ENOENT/);
});
