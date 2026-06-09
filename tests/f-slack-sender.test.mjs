// tests/f-slack-sender.test.mjs — Phase 3: Slack sender-id pairing parity.
// Before this, Slack's _simulateInbound dropped the sender, so a Slack
// listener forwarding to the daemon could never satisfy a pairing allowlist
// (every message would 403, or with empty pairing answer anyone). Now Slack
// captures event.user and forwards it like telegram/matrix, so all three
// channels are gated symmetrically.

import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackChannel } from '../channels/slack.mjs';
import { makeInboundHandler } from '../lib/inbound_client.mjs';

function mkSlack() {
  // Fake tokens so validateEnv passes without real Slack creds.
  return new SlackChannel({ botToken: 'xoxb-test', appToken: 'xapp-test' });
}

test('SlackChannel forwards senderId to the handler', async () => {
  const ch = mkSlack();
  let got = null;
  await ch.start(async (evt) => { got = evt; return null; }); // null reply => no send()
  await ch._simulateInbound('hello', 'C1:ts', 'U777');
  assert.equal(got.channel, 'slack');
  assert.equal(got.threadId, 'C1:ts');
  assert.equal(got.senderId, 'U777');
});

test('SlackChannel: senderId optional (2-arg call) -> null, no crash', async () => {
  const ch = mkSlack();
  let got = null;
  await ch.start(async (evt) => { got = evt; return null; });
  await ch._simulateInbound('hi', 'C1:ts');
  assert.equal(got.senderId, null);
});

test('end-to-end: all three channels pass senderId into postInbound', async () => {
  // A stub daemon that enforces a one-sender allowlist, exactly like
  // /inbound's pairing gate (403 unless senderId === paired).
  const PAIRED = 'U-allowed';
  const stubPost = async (o) => {
    if (o.senderId !== PAIRED) { const e = new Error('sender not paired'); e.code = 'NOT_PAIRED'; throw e; }
    return { reply: 'ok' };
  };
  const seen = {};
  const mkHandler = (channel) => makeInboundHandler(
    { channel, daemonUrl: 'http://d' },
    { postInbound: async (o) => { seen[channel] = o.senderId; return stubPost(o); }, log: () => {} },
  );

  // Slack: drive through the real channel so we exercise the senderId thread.
  const slack = mkSlack();
  slack.send = async () => {}; // stub the outbound API (no real Slack creds in test)
  await slack.start(mkHandler('slack'));
  await slack._simulateInbound('<@U1> ping', 'C1:ts', PAIRED);
  assert.equal(seen.slack, PAIRED, 'slack senderId reached the bridge');

  // Paired sender -> reply; unpaired -> silent null (handler swallows 403).
  const h = mkHandler('telegram');
  assert.equal(await h({ threadId: 't', text: 'x', senderId: PAIRED }), 'ok');
  assert.equal(await h({ threadId: 't', text: 'x', senderId: 'U-stranger' }), null);

  const hm = mkHandler('matrix');
  assert.equal(await hm({ threadId: 'r', text: 'x', senderId: PAIRED }), 'ok');
  assert.equal(await hm({ threadId: 'r', text: 'x', senderId: '@stranger:s' }), null);
});
