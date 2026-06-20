// tests/f-gateway-plugin-deps.test.mjs — the gateway runs the in-tree plugin
// channels (discord/email/whatsapp/…), but their lazy `import('discord.js')`
// resolved from lazyclaw's own node_modules, not the config dir where
// `lazyclaw channels install` puts the dep — so an installed dep was never
// found. And the factory was called with only { allowlist }, so email (no env
// fallback) always threw IMAP_CONFIG_MISSING. These pin the dep-resolution and
// credential threading.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _makeDepLoader, _pluginChannelOpts, _loadPluginChannel } from '../commands/gateway.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc-gwdep-'));

test('_makeDepLoader resolves a dependency installed in <cfgDir>/node_modules', async () => {
  const dir = tmp();
  const dep = path.join(dir, 'node_modules', 'faux-dep');
  fs.mkdirSync(dep, { recursive: true });
  fs.writeFileSync(path.join(dep, 'package.json'), JSON.stringify({ name: 'faux-dep', version: '1.0.0', type: 'module', main: 'index.mjs' }));
  fs.writeFileSync(path.join(dep, 'index.mjs'), 'export const marker = "FROM_CFGDIR";');
  const loadDep = _makeDepLoader(dir);
  const mod = await loadDep('faux-dep');
  assert.equal(mod.marker, 'FROM_CFGDIR', 'dep must resolve from the config dir');
});

test('_pluginChannelOpts maps env creds to the in-tree adapter constructor opts', () => {
  const dir = '/cfg';
  const env = { DISCORD_BOT_TOKEN: 'd1', EMAIL_IMAP_HOST: 'imap.x', EMAIL_IMAP_USER: 'u', EMAIL_IMAP_PASS: 'p' };
  assert.equal(_pluginChannelOpts('discord', env, dir).token, 'd1');
  const e = _pluginChannelOpts('email', env, dir);
  assert.equal(e.imap.host, 'imap.x');
  assert.equal(e.imap.user, 'u');
  assert.equal(e.imap.password, 'p');
  assert.equal(_pluginChannelOpts('whatsapp', env, dir).dataPath, path.join(dir, 'whatsapp'));
});

test('_loadPluginChannel threads loadDep + creds into the channel factory', async () => {
  let received = null;
  const fakeMod = {
    register({ addChannel }) {
      addChannel('discord', (opts) => {
        received = opts;
        return { start: async () => {}, send: async () => {}, stop: async () => {} };
      });
    },
  };
  const factory = await _loadPluginChannel('discord', { importer: async () => fakeMod, cfgDir: '/cfg', env: { DISCORD_BOT_TOKEN: 'tok9' } });
  assert.equal(typeof factory, 'function');
  await factory({ handler: async () => '', logger: () => {}, allowlist: null });
  assert.equal(typeof received.loadDep, 'function', 'loadDep must be injected into the adapter');
  assert.equal(received.token, 'tok9', 'env creds must be threaded into the adapter');
});
