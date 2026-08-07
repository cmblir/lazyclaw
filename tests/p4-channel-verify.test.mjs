// tests/p4-channel-verify.test.mjs — verifyChannel does a live credential check
// (Slack auth.test / Telegram getMe / Matrix whoami) with an injectable fetch,
// and /channels <name> test surfaces ✓/✗ in chat.

import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyChannel } from '../commands/setup_channels.mjs';

const okFetch = (body, ok = true) => async () => ({ ok, json: async () => body });

test('slack verify ok', async () => {
  const r = await verifyChannel('slack', { env: { SLACK_BOT_TOKEN: 'xoxb-x' }, fetchImpl: okFetch({ ok: true, team: 'Acme', user: 'bot' }) });
  assert.equal(r.ok, true);
  assert.match(r.detail, /Acme/);
});

test('slack verify rejected token', async () => {
  const r = await verifyChannel('slack', { env: { SLACK_BOT_TOKEN: 'bad' }, fetchImpl: okFetch({ ok: false, error: 'invalid_auth' }) });
  assert.equal(r.ok, false);
  assert.match(r.detail, /invalid_auth/);
  assert.match(r.hint, /setup/);
});

test('slack verify no token → actionable', async () => {
  const r = await verifyChannel('slack', { env: {}, fetchImpl: okFetch({}) });
  assert.equal(r.ok, false);
  assert.match(r.detail, /no SLACK_BOT_TOKEN/);
});

test('telegram verify ok', async () => {
  const r = await verifyChannel('telegram', { env: { TELEGRAM_BOT_TOKEN: 't' }, fetchImpl: okFetch({ ok: true, result: { username: 'mybot' } }) });
  assert.equal(r.ok, true);
  assert.match(r.detail, /mybot/);
});

test('matrix verify ok', async () => {
  const r = await verifyChannel('matrix', { env: { MATRIX_HOMESERVER: 'https://m.org', MATRIX_ACCESS_TOKEN: 'tok' }, fetchImpl: okFetch({ user_id: '@me:m.org' }) });
  assert.equal(r.ok, true);
  assert.equal(r.detail, '@me:m.org');
});

test('http channel has no live verification (ok=null)', async () => {
  const r = await verifyChannel('http', { env: {}, fetchImpl: okFetch({}) });
  assert.equal(r.ok, null);
});

test('network failure is reported, not thrown', async () => {
  const r = await verifyChannel('slack', { env: { SLACK_BOT_TOKEN: 'x' }, fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
  assert.equal(r.ok, false);
  assert.match(r.detail, /could not reach/);
});

// Slack's auth.test response carries the identity of the account the token
// belongs to. /setup needs `user_id` to offer the operator a pairing default
// instead of making them go find their own Slack ID, so verifyChannel keeps the
// raw fields alongside the human-readable `detail` rather than discarding them.
test('slack verify exposes the identity auth.test returned', async () => {
  const r = await verifyChannel('slack', {
    env: { SLACK_BOT_TOKEN: 'xoxb-x' },
    fetchImpl: okFetch({ ok: true, team: 'Acme', user: 'pompos', user_id: 'U123', team_id: 'T456', bot_id: 'B789' }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.identity.userId, 'U123');
  assert.equal(r.identity.teamId, 'T456');
  assert.equal(r.identity.user, 'pompos');
  assert.equal(r.identity.team, 'Acme');
});

test('slack verify identity is absent, not a throw, when auth.test omits the ids', async () => {
  const r = await verifyChannel('slack', {
    env: { SLACK_BOT_TOKEN: 'xoxb-x' },
    fetchImpl: okFetch({ ok: true, team: 'Acme', user: 'pompos' }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.identity.userId, null);
  assert.equal(r.identity.team, 'Acme');
});

test('a rejected slack token carries no identity', async () => {
  const r = await verifyChannel('slack', {
    env: { SLACK_BOT_TOKEN: 'bad' },
    fetchImpl: okFetch({ ok: false, error: 'invalid_auth' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.identity, null);
});
