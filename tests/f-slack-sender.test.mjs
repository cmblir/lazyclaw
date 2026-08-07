// tests/f-slack-sender.test.mjs — Phase 3: Slack sender-id pairing parity.
// Before this, Slack's _simulateInbound dropped the sender, so a Slack
// listener forwarding to the daemon could never satisfy a pairing allowlist
// (every message would 403, or with empty pairing answer anyone). Now Slack
// captures event.user and forwards it like telegram/matrix, so all three
// channels are gated symmetrically.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

// ── handler errors must not reach the channel ────────────────────────
// _simulateInbound echoed `(error: ${err.message})` into Slack. A provider's
// ApiError message is built from the upstream response body — see
// providers/anthropic.mjs: `anthropic api ${status}: ${body.slice(0, 200)}` — so
// an upstream payload was being shown to whoever was talking to the bot.
// telegram.mjs and matrix.mjs already replied a generic notice and logged the
// detail; Slack was the one that did not.

function apiErrorLike() {
  const err = new Error('anthropic api 400: {"type":"error","error":{"message":"x-api-key sk-ant-SECRET is invalid"}}');
  err.name = 'AnthropicApiError';
  err.status = 400;
  return err;
}

test('a provider error is not echoed into the Slack channel', async () => {
  const ch = mkSlack();
  const sent = [];
  ch.send = async (_thread, text) => { sent.push(text); };
  const logged = [];
  await ch.start(async () => { throw apiErrorLike(); }, { logger: (l) => logged.push(l) });

  await ch._simulateInbound('hi', 'C1:ts', 'U1');

  assert.deepEqual(sent, ['(internal error)'], 'the channel gets a generic notice only');
  for (const bad of [/sk-ant-SECRET/, /anthropic api 400/, /x-api-key/]) {
    assert.doesNotMatch(sent.join(''), bad, `upstream detail ${bad} must not reach the channel`);
  }
  // The operator still needs the real reason.
  assert.match(logged.join(''), /\[slack\] handler error:/);
  assert.match(logged.join(''), /sk-ant-SECRET/, 'full detail goes to the diagnostic sink');
});

test('a gate denial is still surfaced — that reason is ours and safe', async () => {
  const ch = mkSlack();
  const sent = [];
  ch.send = async (_thread, text) => { sent.push(text); };
  const gated = new Error('rate_limited');
  gated.code = 'CHANNEL_GATED';
  await ch.start(async () => { throw gated; });
  await ch._simulateInbound('hi', 'C1:ts', 'U1');
  assert.deepEqual(sent, ['(gated: rate_limited)'],
    'ChannelGated carries our own text, not an upstream body');
});

test('a failure to deliver the notice is logged, not thrown', async () => {
  const ch = mkSlack();
  ch.send = async () => { throw new Error('slack send failed: channel_not_found'); };
  const logged = [];
  await ch.start(async () => { throw apiErrorLike(); }, { logger: (l) => logged.push(l) });
  await ch._simulateInbound('hi', 'C1:ts', 'U1');   // must not reject
  assert.match(logged.join(''), /failed to deliver error notice/);
});

test('no channel adapter sends a raw error message to the remote party', () => {
  // Slack diverged from its two siblings for as long as this existed, which is
  // how the leak survived. Pin the invariant across the directory so the next
  // adapter cannot reintroduce it.
  const dir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'channels');
  const offenders = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.mjs')) continue;
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const line of src.split('\n')) {
      // A send() whose payload interpolates an error object. `(gated: ...)` is
      // exempt: ChannelGated carries our own reason ('rate_limited' /
      // 'unauthorized'), which is a user-facing condition by design.
      if (!/\.send\(/.test(line)) continue;
      if (/\(gated:/.test(line)) continue;
      if (/\$\{\s*(err|error|e)\b[^}]*\}/.test(line)) offenders.push(`${name}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [],
    'reply a generic notice and log the detail to the diagnostic sink instead');
});
