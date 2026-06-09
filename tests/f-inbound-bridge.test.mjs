// tests/f-inbound-bridge.test.mjs — Phase 2: channel listeners stop calling
// the provider inline and instead POST to the daemon's session-bearing
// /inbound, so chat + dashboard + every channel share ONE session/memory.
//
// Covers the HTTP client (postInbound: body shape, auth header, pairing 403,
// ECONNREFUSED backoff, HTTP error) and the shared handler factory
// (makeInboundHandler: slack mention-strip, empty-drop, unpaired silence,
// daemon-down fallback text, senderId passthrough).

import test from 'node:test';
import assert from 'node:assert/strict';
import { postInbound, makeInboundHandler, InboundClientError } from '../lib/inbound_client.mjs';

function okResp(json) {
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
}
function errResp(status, text) {
  return { ok: false, status, json: async () => ({}), text: async () => text || '' };
}

test('postInbound: builds body + Bearer header, returns parsed reply', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => { seen = { url, init }; return okResp({ reply: 'hi', sessionId: 'ib_x' }); };
  const out = await postInbound(
    { url: 'http://127.0.0.1:19600/', authToken: 'T', channel: 'slack', externalId: 'C1:ts', senderId: 'U9', text: 'yo', provider: 'orchestrator', model: 'm' },
    { fetchImpl },
  );
  assert.equal(out.reply, 'hi');
  assert.equal(seen.url, 'http://127.0.0.1:19600/inbound');
  assert.equal(seen.init.headers['authorization'], 'Bearer T');
  const body = JSON.parse(seen.init.body);
  assert.deepEqual(body, { text: 'yo', channel: 'slack', externalId: 'C1:ts', senderId: 'U9', provider: 'orchestrator', model: 'm' });
});

test('postInbound: omits senderId/provider/model when absent (slack, no sender yet)', async () => {
  let body = null;
  const fetchImpl = async (_u, init) => { body = JSON.parse(init.body); return okResp({ reply: 'ok' }); };
  await postInbound({ url: 'http://d', channel: 'slack', externalId: 't', text: 'hi' }, { fetchImpl });
  assert.deepEqual(body, { text: 'hi', channel: 'slack', externalId: 't' });
  assert.equal('authorization' in (body.headers || {}), false);
});

test('postInbound: 403 -> NOT_PAIRED, not retried', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return errResp(403, 'sender not paired'); };
  let err = null;
  try { await postInbound({ url: 'http://d', text: 'x' }, { fetchImpl, retries: 3 }); } catch (e) { err = e; }
  assert.ok(err instanceof InboundClientError);
  assert.equal(err.code, 'NOT_PAIRED');
  assert.equal(calls, 1, 'must not retry a definitive 403');
});

test('postInbound: ECONNREFUSED retries with backoff, then succeeds', async () => {
  let calls = 0;
  const sleeps = [];
  const fetchImpl = async () => {
    calls++;
    if (calls < 3) { const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; }
    return okResp({ reply: 'late' });
  };
  const out = await postInbound({ url: 'http://d', text: 'x' }, { fetchImpl, retries: 5, backoffMs: 1, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } });
  assert.equal(out.reply, 'late');
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2, 'two backoffs before the third attempt succeeded');
});

test('postInbound: ECONNREFUSED past retries -> DAEMON_UNREACHABLE', async () => {
  const fetchImpl = async () => { const e = new Error('ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; };
  let err = null;
  try { await postInbound({ url: 'http://d', text: 'x' }, { fetchImpl, retries: 2, backoffMs: 1, sleep: () => Promise.resolve() }); } catch (e) { err = e; }
  assert.ok(err instanceof InboundClientError);
  assert.equal(err.code, 'DAEMON_UNREACHABLE');
});

test('postInbound: HTTP 500 -> HTTP_ERROR, not retried', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return errResp(500, 'boom'); };
  let err = null;
  try { await postInbound({ url: 'http://d', text: 'x' }, { fetchImpl, retries: 3 }); } catch (e) { err = e; }
  assert.equal(err.code, 'HTTP_ERROR');
  assert.equal(err.status, 500);
  assert.equal(calls, 1);
});

// ---- shared handler factory ----
test('makeInboundHandler: slack strips @mention, posts channel+externalId, returns reply', async () => {
  let posted = null;
  const handler = makeInboundHandler(
    { channel: 'slack', daemonUrl: 'http://d', daemonToken: 'T', provider: 'p', model: 'm' },
    { postInbound: async (o) => { posted = o; return { reply: 'pong' }; }, log: () => {} },
  );
  const reply = await handler({ threadId: 'C1:ts', text: '<@U123> ping' });
  assert.equal(reply, 'pong');
  assert.equal(posted.channel, 'slack');
  assert.equal(posted.externalId, 'C1:ts');
  assert.equal(posted.text, 'ping', 'mention stripped + trimmed');
  assert.equal(posted.provider, 'p');
  assert.equal(posted.url, 'http://d');
});

test('makeInboundHandler: telegram passes senderId, no mention strip', async () => {
  let posted = null;
  const handler = makeInboundHandler(
    { channel: 'telegram', daemonUrl: 'http://d' },
    { postInbound: async (o) => { posted = o; return { reply: 'r' }; }, log: () => {} },
  );
  await handler({ threadId: 'tg:42', text: 'hello <@x>', senderId: '42' });
  assert.equal(posted.senderId, '42');
  assert.equal(posted.text, 'hello <@x>', 'telegram does not strip <@…>');
});

test('makeInboundHandler: empty-after-strip drops (returns null, no POST)', async () => {
  let called = false;
  const handler = makeInboundHandler(
    { channel: 'slack', daemonUrl: 'http://d' },
    { postInbound: async () => { called = true; return { reply: 'x' }; }, log: () => {} },
  );
  const r = await handler({ threadId: 't', text: '   <@U1>  ' });
  assert.equal(r, null);
  assert.equal(called, false);
});

test('makeInboundHandler: NOT_PAIRED -> silent null', async () => {
  const handler = makeInboundHandler(
    { channel: 'slack', daemonUrl: 'http://d' },
    { postInbound: async () => { throw new InboundClientError('nope', 'NOT_PAIRED', 403); }, log: () => {} },
  );
  assert.equal(await handler({ threadId: 't', text: 'hi' }), null);
});

test('makeInboundHandler: daemon unreachable -> generic unavailable text (no leak)', async () => {
  const handler = makeInboundHandler(
    { channel: 'slack', daemonUrl: 'http://d' },
    { postInbound: async () => { throw new InboundClientError('connect ECONNREFUSED 127.0.0.1:19600', 'DAEMON_UNREACHABLE'); }, log: () => {} },
  );
  const r = await handler({ threadId: 't', text: 'hi' });
  assert.match(r, /unavailable/i);
  assert.doesNotMatch(r, /ECONNREFUSED/, 'internal error detail must not leak into the channel');
});

test('makeInboundHandler: empty daemon reply -> null', async () => {
  const handler = makeInboundHandler(
    { channel: 'matrix', daemonUrl: 'http://d' },
    { postInbound: async () => ({ reply: '   ' }), log: () => {} },
  );
  assert.equal(await handler({ threadId: 't', text: 'hi', senderId: '@a:b' }), null);
});
