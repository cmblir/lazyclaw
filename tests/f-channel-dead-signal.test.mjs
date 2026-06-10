// tests/f-channel-dead-signal.test.mjs — a dying poll loop must be VISIBLE.
// A live gateway whose telegram/matrix poll exits (revoked token, stray
// abort) previously looked healthy while being deaf on that channel. Now an
// abnormal loop exit calls onDead (default: throw -> crash handlers ->
// service-manager restart). Driven against local mock HTTP servers.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { TelegramChannel } from '../channels/telegram.mjs';
import { MatrixChannel } from '../channels/matrix.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mockServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test('telegram: 401 from getUpdates -> TELEGRAM_AUTH_FATAL -> onDead fires, loop stops', async () => {
  let polls = 0;
  const { srv, url } = await mockServer((req, res) => {
    polls++;
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, description: 'Unauthorized' }));
  });
  const deaths = [];
  const ch = new TelegramChannel({ token: '123:revoked', apiBase: url });
  try {
    await ch.start(async () => null, {
      poll: true,
      logger: () => {},
      onDead: (err) => deaths.push(err),
    });
    for (let i = 0; i < 50 && deaths.length === 0; i++) await sleep(50);
    assert.equal(deaths.length, 1, 'onDead fired exactly once');
    assert.equal(deaths[0].code, 'TELEGRAM_AUTH_FATAL');
    const pollsAtDeath = polls;
    await sleep(300);
    assert.equal(polls, pollsAtDeath, 'loop stopped — no further polling after fatal auth');
  } finally {
    await ch.stop();
    srv.close();
  }
});

test('matrix: 401 from /sync -> MATRIX_AUTH_FATAL -> onDead fires, loop stops', async () => {
  let polls = 0;
  const { srv, url } = await mockServer((req, res) => {
    polls++;
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errcode: 'M_UNKNOWN_TOKEN' }));
  });
  const deaths = [];
  const ch = new MatrixChannel({ homeserver: 'mock.test', apiBase: url, accessToken: 'revoked' });
  try {
    await ch.start(async () => null, {
      poll: true,
      logger: () => {},
      onDead: (err) => deaths.push(err),
    });
    for (let i = 0; i < 50 && deaths.length === 0; i++) await sleep(50);
    assert.equal(deaths.length, 1, 'onDead fired exactly once');
    assert.equal(deaths[0].code, 'MATRIX_AUTH_FATAL');
    const pollsAtDeath = polls;
    await sleep(300);
    assert.equal(polls, pollsAtDeath, 'loop stopped — no further polling after fatal auth');
  } finally {
    await ch.stop();
    srv.close();
  }
});

test('telegram: clean stop() does NOT fire onDead', async () => {
  const { srv, url } = await mockServer((req, res) => {
    // Hold the long-poll open; stop() must abort it promptly.
    setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: [] })); }, 30_000);
  });
  const deaths = [];
  const ch = new TelegramChannel({ token: '123:ok', apiBase: url });
  await ch.start(async () => null, { poll: true, logger: () => {}, onDead: (e) => deaths.push(e) });
  await sleep(100);
  const t0 = Date.now();
  await ch.stop();
  assert.ok(Date.now() - t0 < 2000, 'stop() returned promptly (held-open poll aborted)');
  assert.equal(deaths.length, 0, 'shutdown is a clean exit, not a death');
  srv.close();
  srv.closeAllConnections?.();
});
