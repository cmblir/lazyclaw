// tests/f-slack-socket-mode.test.mjs — Socket Mode transport.
//
// channels/slack.mjs crossed the 500-line file-size gate, and _connectSocketMode
// (248 lines — over half the file) was the natural seam to split out. It had NO
// test coverage at all, so the extraction would otherwise have been unverified:
// a `this` left unconverted, a missing import, or a broken delegation would only
// have surfaced the first time an operator ran `pompos slack listen`.
//
// The adapter documents SLACK_API_BASE as the test seam for pointing it at a
// local mock, and the WebSocket contract is addEventListener-based, so both
// halves can be faked in-process.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SlackChannel } from '../channels/slack.mjs';

function mkSlack(apiBase) {
  return new SlackChannel({ botToken: 'xoxb-test', appToken: 'xapp-test', apiBase });
}

// Slack Web API stand-in: apps.connections.open hands back a ws URL, auth.test
// reports our own identity (which the self-message loop filter needs).
async function mockSlackApi({ open = { ok: true, url: 'wss://fake/link' },
                              auth = { ok: true, user_id: 'U_SELF', bot_id: 'B_SELF' },
                              openStatus = 200 } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const body = req.url.includes('auth.test') ? auth : open;
    res.writeHead(req.url.includes('auth.test') ? 200 : openStatus,
      { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, hits,
           close: () => new Promise((r) => server.close(() => r())) };
}

// Minimal WebSocket good enough for the transport: it records sends and lets a
// test push frames in. Installed as globalThis.WebSocket for the duration.
function installFakeWebSocket() {
  const sockets = [];
  const prev = globalThis.WebSocket;
  globalThis.WebSocket = class FakeWS {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this._listeners = new Map();
      sockets.push(this);
      // 'open' must arrive after the caller has attached its listeners.
      setTimeout(() => this._fire('open', {}), 0);
    }
    addEventListener(name, fn) {
      if (!this._listeners.has(name)) this._listeners.set(name, []);
      this._listeners.get(name).push(fn);
    }
    _fire(name, ev) { return Promise.all((this._listeners.get(name) || []).map((fn) => fn(ev))); }
    send(data) { this.sent.push(data); }
    close() { this._fire('close', {}); }
    // Push a Socket Mode frame at the adapter and wait for it to be handled.
    push(obj) { return this._fire('message', { data: JSON.stringify(obj) }); }
  };
  return { sockets, restore: () => { globalThis.WebSocket = prev; } };
}

test('the extracted transport connects, resolves self identity, and returns a handle', async () => {
  const api = await mockSlackApi();
  const ws = installFakeWebSocket();
  try {
    const ch = mkSlack(api.base);
    const logged = [];
    await ch.start(async () => null);
    const handle = await ch._connectSocketMode({ logger: (l) => logged.push(l) });

    assert.equal(typeof handle.disconnect, 'function', 'callers get a disconnect handle');
    assert.equal(handle, ch._socketHandle, 'and it is stored on the channel');
    assert.equal(ws.sockets.length, 1);
    assert.equal(ws.sockets[0].url, 'wss://fake/link', 'dialled the URL apps.connections.open returned');
    // `ch._env`, `ch._selfUserId`, `ch._selfBotId` are the fields the extraction
    // rewrote from `this`; an unconverted one would leave these undefined.
    assert.equal(ch._selfUserId, 'U_SELF');
    assert.equal(ch._selfBotId, 'B_SELF');
    assert.ok(api.hits.some((u) => u.includes('apps.connections.open')));
    assert.ok(api.hits.some((u) => u.includes('auth.test')));
    assert.match(logged.join(''), /socket-mode connected/);
  } finally { ws.restore(); await api.close(); }
});

test('the logger passed here becomes the channel diagnostic sink', async () => {
  // `slack listen` reaches the adapter through _connectSocketMode, not start(),
  // so this is the only place the production sink gets attached — and without it
  // a handler error would be dropped silently rather than shown to the operator.
  const api = await mockSlackApi();
  const ws = installFakeWebSocket();
  try {
    const ch = mkSlack(api.base);
    const logged = [];
    await ch.start(async () => { throw new Error('anthropic api 400: SECRET-BODY'); });
    await ch._connectSocketMode({ logger: (l) => logged.push(l) });
    ch.send = async () => {};

    await ch._simulateInbound('hi', 'C1:ts', 'U1');
    assert.match(logged.join(''), /\[slack\] handler error:/);
    assert.match(logged.join(''), /SECRET-BODY/, 'the operator sees the real reason');
  } finally { ws.restore(); await api.close(); }
});

test('an events_api envelope is acked and dispatched to the handler', async () => {
  const api = await mockSlackApi();
  const ws = installFakeWebSocket();
  try {
    const ch = mkSlack(api.base);
    const seen = [];
    await ch.start(async (evt) => { seen.push(evt.text); return null; });
    await ch._connectSocketMode({ logger: () => {} });
    const sock = ws.sockets[0];

    await sock.push({ type: 'events_api', envelope_id: 'e1',
      payload: { event: { type: 'app_mention', text: 'hello there', channel: 'C1', ts: '1.0', user: 'U9' } } });

    assert.deepEqual(JSON.parse(sock.sent[0]), { envelope_id: 'e1' }, 'the envelope must be acked');
    assert.deepEqual(seen, ['hello there']);
  } finally { ws.restore(); await api.close(); }
});

test('a repeated envelope_id is ignored', async () => {
  const api = await mockSlackApi();
  const ws = installFakeWebSocket();
  try {
    const ch = mkSlack(api.base);
    const seen = [];
    await ch.start(async (evt) => { seen.push(evt.text); return null; });
    await ch._connectSocketMode({ logger: () => {} });
    const sock = ws.sockets[0];
    const frame = { type: 'events_api', envelope_id: 'dup',
      payload: { event: { type: 'app_mention', text: 'once', channel: 'C1', ts: '2.0', user: 'U9' } } };

    await sock.push(frame);
    await sock.push(frame);
    assert.deepEqual(seen, ['once'], 'a redelivered envelope must not run the handler twice');
  } finally { ws.restore(); await api.close(); }
});

test('the transport surfaces a failed apps.connections.open instead of hanging', async () => {
  const api = await mockSlackApi({ open: { ok: false, error: 'invalid_auth' } });
  const ws = installFakeWebSocket();
  try {
    const ch = mkSlack(api.base);
    await ch.start(async () => null);
    await assert.rejects(() => ch._connectSocketMode({ logger: () => {} }),
      (err) => err.code === 'SLACK_OPEN_FAIL' && /invalid_auth/.test(err.message));
    assert.equal(ws.sockets.length, 0, 'no socket is dialled when the handshake failed');
  } finally { ws.restore(); await api.close(); }
});

test('Socket Mode refuses to start without a global WebSocket', async () => {
  const api = await mockSlackApi();
  const prev = globalThis.WebSocket;
  // eslint-disable-next-line no-undef
  globalThis.WebSocket = undefined;
  try {
    const ch = mkSlack(api.base);
    await ch.start(async () => null);
    await assert.rejects(() => ch._connectSocketMode({ logger: () => {} }),
      (err) => err.code === 'SLACK_NO_WS');
  } finally { globalThis.WebSocket = prev; await api.close(); }
});
