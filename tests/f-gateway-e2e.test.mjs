// tests/f-gateway-e2e.test.mjs — Phase 5: the single-process gateway.
// Drives the REAL runGateway (real in-process daemon on an ephemeral port,
// real loopback /inbound with pairing + dedup + session binding) with STUB
// channel transports, so the whole approach-B pipeline is exercised without
// Slack/Telegram/Matrix creds:
//   channel handler -> POST /inbound -> session-bound mock reply
//   POST /handoff -> live channelSenders notify -> rollback on send failure
//   context follows the handoff (same sessionId on the new externalId).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGateway, _selectChannels, GATEWAY_CHANNELS } from '../commands/gateway.mjs';
import { GatewayGuardError } from '../lib/gateway_guard.mjs';

function mkCfgDir(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lz-gw-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg), { mode: 0o600 });
  return dir;
}

function stubChannel({ failSend = false } = {}) {
  const state = { handler: null, sent: [], stopped: false };
  const factory = async ({ handler }) => {
    state.handler = handler;
    return {
      send: async (externalId, text) => {
        if (failSend) throw new Error('transport down');
        state.sent.push([externalId, text]);
      },
      stop: async () => { state.stopped = true; },
    };
  };
  return { state, factory };
}

test('_selectChannels: flags override, cfg-enabled default, unknowns dropped', () => {
  assert.deepEqual(
    _selectChannels({}, { channels: 'slack, MATRIX,bogus' }),
    ['slack', 'matrix'],
  );
  assert.deepEqual(
    _selectChannels({ channels: { slack: { enabled: true }, telegram: { enabled: false }, matrix: {} } }, {}),
    ['slack', 'matrix'],
  );
  assert.deepEqual(_selectChannels({}, {}), []);
  assert.deepEqual(GATEWAY_CHANNELS, ['slack', 'telegram', 'matrix']);
});

test('gateway boot guard: refuses allowUnattendedSensitive', async () => {
  const dir = mkCfgDir({ provider: 'mock', security: { allowUnattendedSensitive: true } });
  const prev = process.env.LAZYCLAW_CONFIG_DIR;
  process.env.LAZYCLAW_CONFIG_DIR = dir;
  try {
    await assert.rejects(() => runGateway({ port: 0 }, { log: () => {} }), GatewayGuardError);
  } finally {
    process.env.LAZYCLAW_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gateway e2e: inbound through the core, live handoff notify + rollback', async () => {
  const dir = mkCfgDir({
    provider: 'mock',
    trainer: { provider: 'mock' },
    pairing: [{ id: 'U1' }],
    channels: { slack: { enabled: true }, telegram: { enabled: true } },
  });
  const prev = process.env.LAZYCLAW_CONFIG_DIR;
  process.env.LAZYCLAW_CONFIG_DIR = dir;
  const slack = stubChannel();
  const telegram = stubChannel({ failSend: true });
  let gw = null;
  try {
    gw = await runGateway({ port: 0 }, {
      log: () => {},
      channelFactories: { slack: slack.factory, telegram: telegram.factory },
    });
    assert.ok(gw.port > 0);
    assert.deepEqual(gw.channels.map((c) => c.name).sort(), ['slack', 'telegram']);
    assert.ok(gw.channelSenders.has('slack') && gw.channelSenders.has('telegram'));
    assert.deepEqual(gw.skipped, []);

    // 1) Paired sender round-trips: stub handler -> loopback /inbound -> mock reply.
    const reply = await slack.state.handler({ threadId: 'C9:1.1', text: 'hello via gateway', senderId: 'U1', messageId: 'C9:1.1' });
    assert.ok(reply && reply.includes('hello via gateway'), `core replied through the bridge (got: ${reply})`);

    // 2) Unpaired sender is silently dropped (daemon 403 -> handler null).
    assert.equal(await slack.state.handler({ threadId: 'C9:1.1', text: 'sneak', senderId: 'U-stranger', messageId: 'C9:1.2' }), null);

    // 3) Duplicate messageId: the core replays internally, but the LISTENER
    //    stays silent (the channel already has the reply — reposting would
    //    double-post on redelivery).
    const dup = await slack.state.handler({ threadId: 'C9:1.1', text: 'hello via gateway', senderId: 'U1', messageId: 'C9:1.1' });
    assert.equal(dup, null);

    // Bound thread for handoff tests.
    const inbound = await fetch(`http://127.0.0.1:${gw.port}/inbound`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + gw.authToken },
      body: JSON.stringify({ channel: 'slack', externalId: 'C9:1.1', senderId: 'U1', text: 'where am i' }),
    }).then((r) => r.json());
    assert.ok(inbound.threadId && inbound.sessionId);

    // 4) Handoff to a channel whose send FAILS -> 502 + binding rolled back.
    const bad = await fetch(`http://127.0.0.1:${gw.port}/handoff`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + gw.authToken },
      body: JSON.stringify({ threadId: inbound.threadId, target: 'telegram', externalId: 'tg:777' }),
    });
    assert.equal(bad.status, 502);
    assert.equal((await bad.json()).code, 'HANDOFF_SEND_FAILED');
    const stillSlack = await fetch(`http://127.0.0.1:${gw.port}/inbound`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + gw.authToken },
      body: JSON.stringify({ channel: 'slack', externalId: 'C9:1.1', senderId: 'U1', text: 'still here?' }),
    }).then((r) => r.json());
    assert.equal(stillSlack.sessionId, inbound.sessionId, 'rollback kept the slack binding');

    // 5) Handoff to a HEALTHY channel -> 200, resume marker delivered, context follows.
    const good = await fetch(`http://127.0.0.1:${gw.port}/handoff`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + gw.authToken },
      body: JSON.stringify({ threadId: inbound.threadId, target: 'slack', externalId: 'C9:NEW' }),
    });
    assert.equal(good.status, 200);
    assert.equal(slack.state.sent.length, 1);
    assert.equal(slack.state.sent[0][0], 'C9:NEW');
    assert.match(slack.state.sent[0][1], /resumed from slack/);
    const followed = await fetch(`http://127.0.0.1:${gw.port}/inbound`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + gw.authToken },
      body: JSON.stringify({ channel: 'slack', externalId: 'C9:NEW', senderId: 'U1', text: 'did you follow me' }),
    }).then((r) => r.json());
    assert.equal(followed.sessionId, inbound.sessionId, 'context followed the handoff');

    // 6) stop() drains channels and frees the port.
    await gw.stop();
    gw = null;
    assert.equal(slack.state.stopped, true);
    assert.equal(telegram.state.stopped, true);
  } finally {
    if (gw) { try { await gw.stop(); } catch { /* already down */ } }
    process.env.LAZYCLAW_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
