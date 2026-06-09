// tests/f-channels-config.test.mjs — channel config view/edit: the shared
// channelStatusList/channelSetEnabled helpers and the /channels slash.

import test from 'node:test';
import assert from 'node:assert/strict';
import { channelStatusList, channelSetEnabled, KNOWN_CHANNELS } from '../config_features.mjs';
import { dispatchSlash } from '../tui/slash_dispatcher.mjs';
import { SLASH_COMMANDS } from '../tui/slash_commands.mjs';

test('channelStatusList lists configured built-ins with enabled state', () => {
  const cfg = { channels: { slack: { enabled: true }, telegram: { enabled: false, agent: 'bot' } } };
  const rows = channelStatusList(cfg);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(byName.slack.enabled, true);
  assert.equal(byName.telegram.enabled, false);
  assert.equal(byName.telegram.boundAgent, 'bot');
  // Unconfigured channels are omitted.
  assert.equal(rows.find((r) => r.name === 'discord'), undefined);
});

test('channelStatusList returns [] for an empty config', () => {
  assert.deepEqual(channelStatusList({}), []);
});

test('channelSetEnabled toggles cfg.channels.<name>.enabled, preserving other keys', () => {
  const cfg = { channels: { slack: { enabled: true, agent: 'a' } } };
  channelSetEnabled(cfg, 'slack', false);
  assert.equal(cfg.channels.slack.enabled, false);
  assert.equal(cfg.channels.slack.agent, 'a', 'other keys preserved');
  channelSetEnabled(cfg, 'telegram', true);
  assert.equal(cfg.channels.telegram.enabled, true, 'creates the section if absent');
});

test('KNOWN_CHANNELS contains every built-in name with no duplicates', () => {
  // Membership/superset, not a brittle magic-number count: every built-in
  // must be present, and the list must have no dupes. A correctly-added
  // 10th built-in won't break this; a missing/duplicated name will.
  const builtins = ['slack', 'matrix', 'telegram', 'discord', 'email', 'signal', 'whatsapp', 'voice', 'http'];
  assert.ok(builtins.every((n) => KNOWN_CHANNELS.includes(n)), 'all built-ins present');
  assert.equal(new Set(KNOWN_CHANNELS).size, KNOWN_CHANNELS.length, 'no duplicate channel names');
});

test('channelStatusList enabled-derivation: absent flag defaults to enabled', () => {
  // config_features.mjs:261 — `enabled: !!(sec && sec.enabled !== false)`.
  // A section with NO enabled flag (and no creds) still reports enabled:true.
  // Documents the no-creds-but-enabled behavior the FOCUS flags as misleading.
  assert.equal(channelStatusList({ channels: { discord: {} } })[0].enabled, true);
  assert.equal(channelStatusList({ channels: { email: { agent: 'x' } } })[0].enabled, true);
});

test('channelStatusList legacy-token-only channel surfaces as disabled', () => {
  // A legacy `<name>-bot-token` channel HAS creds and so appears in the list,
  // but with no cfg.channels.<name> section `sec` is undefined → enabled:false.
  const rows = channelStatusList({ 'slack-bot-token': 'xoxb-fake' });
  const slack = rows.find((r) => r.name === 'slack');
  assert.ok(slack, 'legacy-token channel is listed');
  assert.equal(slack.enabled, false, 'no section → enabled:false despite creds');
});

test('/channels slash lists configured channels (read via ctx)', async () => {
  const ctx = { readConfig: () => ({ channels: { slack: { enabled: true } } }), writeConfig: () => {} };
  const out = await dispatchSlash('/channels', '', ctx, () => {});
  assert.match(out, /configured channels:/);
  assert.match(out, /slack\s+enabled/);
});

test('/channels <name> on|off toggles and persists via ctx.writeConfig', async () => {
  let saved = null;
  const ctx = { readConfig: () => ({ channels: { slack: { enabled: true } } }), writeConfig: (c) => { saved = c; } };
  const out = await dispatchSlash('/channels', 'slack off', ctx, () => {});
  assert.match(out, /slack → disabled/);
  assert.equal(saved.channels.slack.enabled, false, 'writeConfig got the disabled channel');
});

test('/channels rejects an unknown channel name (no config pollution)', async () => {
  let saved = null;
  const ctx = { readConfig: () => ({ channels: {} }), writeConfig: (c) => { saved = c; } };
  const out = await dispatchSlash('/channels', 'slak on', ctx, () => {});
  assert.match(out, /^unknown channel: slak \(known: /, 'returns the rejection string');
  assert.equal(saved, null, 'writeConfig is never called for a bogus name');
});

test('/channels stays permissive for a pre-existing custom section', async () => {
  let saved = null;
  const ctx = { readConfig: () => ({ channels: { custom: { enabled: true } } }), writeConfig: (c) => { saved = c; } };
  const out = await dispatchSlash('/channels', 'custom off', ctx, () => {});
  assert.match(out, /custom → disabled/, 'an already-configured custom section can still be toggled');
  assert.equal(saved.channels.custom.enabled, false);
});

test('/channels is in the slash catalog', () => {
  assert.ok(SLASH_COMMANDS.some((c) => c.cmd === '/channels'));
});
