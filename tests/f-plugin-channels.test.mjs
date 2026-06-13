// tests/f-plugin-channels.test.mjs — g3-plugin-channels.
//
// Pins the gap: before the fix the gateway only ever loaded the 3 builtins
// (slack/telegram/matrix); enabled plugin channels (channels-discord/, etc.)
// were never reachable, so `channels enable discord` succeeded for something
// that could never run. These tests drive the plugin-resolution seam:
//   (a) an enabled, CONFORMING plugin is loaded and adapted to the same
//       gateway transport interface the builtins use;
//   (b) a NON-conforming plugin is skipped with a warning, not a crash;
//   (c) channel selection now includes enabled non-builtin channels.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _loadPluginChannel, _selectChannels, GATEWAY_CHANNELS, PLUGIN_CHANNELS,
} from '../commands/gateway.mjs';

// A fake conforming plugin module: register({ addChannel }) wires a factory
// that returns a channel with start()/send()/stop().
function fakePluginModule(name, { onStart } = {}) {
  return {
    register({ addChannel }) {
      addChannel(name, (opts) => {
        const ch = {
          opts,
          started: null,
          sent: [],
          stopped: false,
          async start(handler, startOpts) { ch.started = { handler, startOpts }; if (onStart) onStart(); },
          async send(threadId, text) { ch.sent.push([threadId, text]); },
          async stop() { ch.stopped = true; },
        };
        return ch;
      });
    },
  };
}

test('PLUGIN_CHANNELS lists the in-tree plugin dirs and excludes builtins', () => {
  for (const b of GATEWAY_CHANNELS) assert.ok(!PLUGIN_CHANNELS.includes(b), `${b} is a builtin, not a plugin`);
  // The repo ships these in-tree plugin dirs (channels-<name>/).
  for (const p of ['discord', 'email', 'signal', 'voice', 'whatsapp']) {
    assert.ok(PLUGIN_CHANNELS.includes(p), `expected ${p} in PLUGIN_CHANNELS`);
  }
});

test('_selectChannels: enabled non-builtin plugin channels are now wanted', () => {
  // Pre-fix this returned only builtins; discord must now be selected.
  assert.deepEqual(
    _selectChannels({ channels: { slack: { enabled: true }, discord: { enabled: true } } }, {}).sort(),
    ['discord', 'slack'],
  );
  // Disabled plugin channel stays out.
  assert.deepEqual(
    _selectChannels({ channels: { discord: { enabled: false } } }, {}),
    [],
  );
  // --channels flag accepts a plugin name too (not just builtins), still drops unknowns.
  assert.deepEqual(
    _selectChannels({}, { channels: 'discord, bogus' }),
    ['discord'],
  );
});

test('_loadPluginChannel: loads a conforming plugin and adapts to the gateway transport interface', async () => {
  let startCount = 0;
  const importer = async () => fakePluginModule('discord', { onStart: () => { startCount++; } });
  const factory = await _loadPluginChannel('discord', { importer });
  assert.equal(typeof factory, 'function', 'returns a gateway transport factory');

  // The gateway transport contract: factory({ handler, logger, allowlist })
  // -> a STARTED channel exposing send()/stop().
  const handler = async () => 'ok';
  const ch = await factory({ handler, logger: () => {}, allowlist: ['U1'] });
  assert.equal(startCount, 1, 'plugin channel was started by the adapter');
  assert.equal(typeof ch.send, 'function');
  assert.equal(typeof ch.stop, 'function');
  // The handler is threaded through to the plugin channel's start().
  assert.equal(ch.started.handler, handler);

  await ch.send('thread-1', 'hi');
  assert.deepEqual(ch.sent, [['thread-1', 'hi']]);
  await ch.stop();
  assert.equal(ch.stopped, true);
});

test('_loadPluginChannel: a NON-conforming plugin is skipped (returns null) instead of throwing', async () => {
  // Plugin whose register() never registers the requested name.
  const wrongName = { register({ addChannel }) { addChannel('something-else', () => ({})); } };
  assert.equal(await _loadPluginChannel('discord', { importer: async () => wrongName }), null);

  // Plugin with no register export at all.
  const noRegister = { foo: 1 };
  assert.equal(await _loadPluginChannel('discord', { importer: async () => noRegister }), null);

  // Plugin whose factory returns an object missing send()/stop() — caught when
  // the gateway transport factory is invoked, not at import time. The adapter
  // factory must reject (so runGateway's per-channel try/catch skips+warns),
  // not return a half-built transport.
  const badShape = { register({ addChannel }) { addChannel('discord', () => ({ start: async () => {} })); } };
  const factory = await _loadPluginChannel('discord', { importer: async () => badShape });
  assert.equal(typeof factory, 'function');
  await assert.rejects(() => factory({ handler: async () => {}, logger: () => {} }), /interface|send|stop|conform/i);

  // Plugin whose import throws (e.g. missing optional dep) is skipped, not fatal.
  assert.equal(await _loadPluginChannel('discord', { importer: async () => { throw new Error('boom'); } }), null);
});
