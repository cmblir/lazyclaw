import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import * as http from 'node:http';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();

async function loadMatrix() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'channels', 'matrix.mjs')).href;
  return await import(url) as typeof import('../channels/matrix.mjs');
}

// In-process mock for a Matrix homeserver's client-server API. The two
// methods we exercise are:
//   GET  /_matrix/client/v3/sync                              — long-poll
//   PUT  /_matrix/client/v3/rooms/<roomId>/send/m.room.message/<txnId>
// We capture every request (path, method, headers, parsed JSON body) so the
// spec can assert the Authorization header, the send endpoint shape, and the
// reply body. /sync returns an empty batch by default; a per-path queue lets
// a test stage a richer sync response when it needs the poll loop to fire.
function startMockMatrix(): Promise<{
  url: string;
  reqs: Array<{ headers: http.IncomingHttpHeaders; body: any; path: string; method: string }>;
  // Response queue keyed by a coarse route name ('sync' | 'send'). When empty,
  // sensible defaults apply.
  queue: Record<string, any[]>;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const reqs: Array<{ headers: http.IncomingHttpHeaders; body: any; path: string; method: string }> = [];
    const queue: Record<string, any[]> = {};
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c.toString(); });
      req.on('end', () => {
        let parsed: any = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
        const url = req.url || '';
        reqs.push({ headers: req.headers, body: parsed, path: url, method: req.method || '' });
        const route = url.includes('/sync') ? 'sync' : (url.includes('/send/') ? 'send' : 'other');
        const next = (queue[route] || []).shift();
        res.writeHead(200, { 'content-type': 'application/json' });
        if (next !== undefined) { res.end(JSON.stringify(next)); return; }
        if (route === 'send') {
          res.end(JSON.stringify({ event_id: '$evt:mock' }));
          return;
        }
        // Default /sync: nothing pending, just advance the batch token.
        res.end(JSON.stringify({ next_batch: 's_empty', rooms: { join: {} } }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        reqs,
        queue,
        close: () => new Promise<void>((r) => {
          try { server.closeAllConnections(); } catch { /* node <18 */ }
          server.close(() => r());
        }),
      });
    });
  });
}

// Helper: build a minimal /sync response that delivers one m.room.message
// text event into a single joined room.
function syncWithMessage(roomId: string, sender: string, body: string, eventId = '$e1') {
  return {
    next_batch: 's_after',
    rooms: {
      join: {
        [roomId]: {
          timeline: {
            events: [
              {
                type: 'm.room.message',
                sender,
                event_id: eventId,
                origin_server_ts: 1,
                content: { msgtype: 'm.text', body },
              },
            ],
          },
        },
      },
    },
  };
}

test.describe('Phase 30 — Matrix channel adapter', () => {
  test('start() without an accessToken throws MATRIX_MISSING_TOKEN', async () => {
    const { MatrixChannel } = await loadMatrix();
    const ch = new MatrixChannel({
      homeserver: 'https://matrix.example',
      accessToken: null,
      userId: '@bot:example',
      apiBase: 'http://127.0.0.1:1',
    });
    let err: any = null;
    try { await ch.start(async () => 'r', { poll: false }); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.code).toBe('MATRIX_MISSING_TOKEN');
    expect(String(err.message)).toMatch(/MATRIX_ACCESS_TOKEN|accessToken/);
    await ch.stop();
  });

  test('start() without a homeserver throws a clear error', async () => {
    const { MatrixChannel } = await loadMatrix();
    const prevHs = process.env.MATRIX_HOMESERVER;
    const prevTok = process.env.MATRIX_ACCESS_TOKEN;
    delete process.env.MATRIX_HOMESERVER;
    delete process.env.MATRIX_ACCESS_TOKEN;
    try {
      const ch = new MatrixChannel({
        homeserver: null,
        accessToken: 'tok',
        userId: '@bot:example',
        apiBase: 'http://127.0.0.1:1',
      });
      let err: any = null;
      try { await ch.start(async () => 'r', { poll: false }); } catch (e) { err = e; }
      expect(err).toBeTruthy();
      expect(String(err.code)).toMatch(/MATRIX_/);
      await ch.stop();
    } finally {
      if (prevHs === undefined) delete process.env.MATRIX_HOMESERVER; else process.env.MATRIX_HOMESERVER = prevHs;
      if (prevTok === undefined) delete process.env.MATRIX_ACCESS_TOKEN; else process.env.MATRIX_ACCESS_TOKEN = prevTok;
    }
  });

  test('accessToken/homeserver fall back to the environment', async () => {
    const { MatrixChannel } = await loadMatrix();
    const prevHs = process.env.MATRIX_HOMESERVER;
    const prevTok = process.env.MATRIX_ACCESS_TOKEN;
    process.env.MATRIX_HOMESERVER = 'https://env.example';
    process.env.MATRIX_ACCESS_TOKEN = 'env-token';
    try {
      const ch = new MatrixChannel({ userId: '@bot:example', apiBase: 'http://127.0.0.1:1' });
      await ch.start(async () => 'r', { poll: false });
      await ch.stop();
    } finally {
      if (prevHs === undefined) delete process.env.MATRIX_HOMESERVER; else process.env.MATRIX_HOMESERVER = prevHs;
      if (prevTok === undefined) delete process.env.MATRIX_ACCESS_TOKEN; else process.env.MATRIX_ACCESS_TOKEN = prevTok;
    }
  });

  test('_simulateInbound routes an m.text event to the handler and PUTs a reply', async () => {
    const mock = await startMockMatrix();
    const { MatrixChannel } = await loadMatrix();
    const ch = new MatrixChannel({
      homeserver: 'https://matrix.example',
      accessToken: 'secret-tok',
      userId: '@bot:example',
      apiBase: mock.url,
    });
    const seen: any[] = [];
    await ch.start(async (evt: any) => { seen.push(evt); return `pong: ${evt.text}`; }, { poll: false });

    await ch._simulateInbound(syncWithMessage('!room1:example', '@alice:example', 'hi there'));

    // Handler observed the normalized event.
    expect(seen).toHaveLength(1);
    expect(seen[0].channel).toBe('matrix');
    expect(seen[0].text).toBe('hi there');
    expect(String(seen[0].threadId)).toBe('matrix:!room1:example');
    expect(String(seen[0].senderId)).toBe('@alice:example');

    // Reply PUT to the room's send endpoint.
    const sends = mock.reqs.filter((p) => p.path.includes('/send/m.room.message/'));
    expect(sends).toHaveLength(1);
    expect(sends[0].method).toBe('PUT');
    expect(sends[0].path).toContain('/rooms/' + encodeURIComponent('!room1:example') + '/send/m.room.message/');
    expect(String(sends[0].headers.authorization)).toBe('Bearer secret-tok');
    expect(sends[0].body.msgtype).toBe('m.text');
    expect(sends[0].body.body).toBe('pong: hi there');

    await ch.stop();
    await mock.close();
  });

  test('send() PUTs to the correct room endpoint with the text (threadId decoded)', async () => {
    const mock = await startMockMatrix();
    const { MatrixChannel } = await loadMatrix();
    const ch = new MatrixChannel({
      homeserver: 'https://matrix.example',
      accessToken: 'send-tok',
      userId: '@bot:example',
      apiBase: mock.url,
    });
    await ch.start(async () => 'r', { poll: false });

    await ch.send('matrix:!abc:example', 'direct hello');
    // A bare room id (no prefix) must resolve to the same endpoint shape.
    await ch.send('!bare:example', 'bare hello');

    const sends = mock.reqs.filter((p) => p.path.includes('/send/m.room.message/'));
    expect(sends).toHaveLength(2);
    expect(sends[0].path).toContain('/rooms/' + encodeURIComponent('!abc:example') + '/send/m.room.message/');
    expect(sends[0].body.body).toBe('direct hello');
    expect(sends[1].path).toContain('/rooms/' + encodeURIComponent('!bare:example') + '/send/m.room.message/');
    expect(sends[1].body.body).toBe('bare hello');
    // txnIds must differ so the homeserver doesn't dedupe the second send.
    const txn0 = sends[0].path.split('/send/m.room.message/').pop();
    const txn1 = sends[1].path.split('/send/m.room.message/').pop();
    expect(txn0).not.toBe(txn1);

    await ch.stop();
    await mock.close();
  });

  test('self-message (event.sender === bot userId) is ignored', async () => {
    const mock = await startMockMatrix();
    const { MatrixChannel } = await loadMatrix();
    const ch = new MatrixChannel({
      homeserver: 'https://matrix.example',
      accessToken: 'self-tok',
      userId: '@bot:example',
      apiBase: mock.url,
    });
    let handlerCalls = 0;
    await ch.start(async () => { handlerCalls++; return 'should-not-fire'; }, { poll: false });

    // The bot's own message must never re-enter the handler (no reply loop).
    await ch._simulateInbound(syncWithMessage('!loop:example', '@bot:example', 'my own echo'));

    expect(handlerCalls).toBe(0);
    const sends = mock.reqs.filter((p) => p.path.includes('/send/m.room.message/'));
    expect(sends).toHaveLength(0);

    await ch.stop();
    await mock.close();
  });

  test('pairing allowlist rejects an unknown sender (no handler call, no reply)', async () => {
    const mock = await startMockMatrix();
    const { MatrixChannel } = await loadMatrix();
    const ch = new MatrixChannel({
      homeserver: 'https://matrix.example',
      accessToken: 'pair-tok',
      userId: '@bot:example',
      apiBase: mock.url,
      allowlist: ['@alice:example'], // only Alice may talk to the bot
    });
    let handlerCalls = 0;
    await ch.start(async () => { handlerCalls++; return 'should-not-fire'; }, { poll: false });

    // @mallory is NOT on the allowlist.
    await ch._simulateInbound(syncWithMessage('!r:example', '@mallory:example', 'let me in'));
    expect(handlerCalls).toBe(0);
    expect(mock.reqs.filter((p) => p.path.includes('/send/m.room.message/'))).toHaveLength(0);

    // An allowed sender still gets through on the same channel instance.
    await ch._simulateInbound(syncWithMessage('!r2:example', '@alice:example', 'i am allowed'));
    expect(handlerCalls).toBe(1);
    const sends = mock.reqs.filter((p) => p.path.includes('/send/m.room.message/'));
    expect(sends).toHaveLength(1);
    expect(sends[0].path).toContain('/rooms/' + encodeURIComponent('!r2:example') + '/send/');

    await ch.stop();
    await mock.close();
  });

  test('the bot reply hits the correct room send endpoint with the text', async () => {
    const mock = await startMockMatrix();
    const { MatrixChannel } = await loadMatrix();
    const ch = new MatrixChannel({
      homeserver: 'https://matrix.example',
      accessToken: 'reply-tok',
      userId: '@bot:example',
      apiBase: mock.url,
    });
    await ch.start(async (evt: any) => `ACK[${evt.text}]`, { poll: false });

    await ch._simulateInbound(syncWithMessage('!target:example', '@carol:example', 'ping'));

    const sends = mock.reqs.filter((p) => p.path.includes('/send/m.room.message/'));
    expect(sends).toHaveLength(1);
    expect(sends[0].path).toContain('/rooms/' + encodeURIComponent('!target:example') + '/send/m.room.message/');
    expect(sends[0].body.body).toBe('ACK[ping]');

    await ch.stop();
    await mock.close();
  });

  test('long-poll consumes /sync and dispatches each inbound message', async () => {
    const mock = await startMockMatrix();
    // First /sync returns one message; subsequent ones return empty.
    mock.queue.sync = [syncWithMessage('!polled:example', '@dave:example', 'polled hello')];
    const { MatrixChannel } = await loadMatrix();
    const ch = new MatrixChannel({
      homeserver: 'https://matrix.example',
      accessToken: 'poll-tok',
      userId: '@bot:example',
      apiBase: mock.url,
    });
    const seen: any[] = [];
    await ch.start(async (evt: any) => { seen.push(evt); return `ack: ${evt.text}`; }, { poll: true });

    const start = Date.now();
    while (seen.length === 0 && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 20));

    expect(seen).toHaveLength(1);
    expect(seen[0].text).toBe('polled hello');

    const syncs = mock.reqs.filter((p) => p.path.includes('/sync'));
    expect(syncs.length).toBeGreaterThanOrEqual(1);
    const sends = mock.reqs.filter((p) => p.path.includes('/send/m.room.message/'));
    expect(sends).toHaveLength(1);
    expect(sends[0].path).toContain('/rooms/' + encodeURIComponent('!polled:example') + '/send/');
    expect(sends[0].body.body).toBe('ack: polled hello');

    await ch.stop();
    await mock.close();
  });

  test('handler error replies a generic notice (no internal detail leak)', async () => {
    const mock = await startMockMatrix();
    const { MatrixChannel } = await loadMatrix();
    const ch = new MatrixChannel({
      homeserver: 'https://matrix.example',
      accessToken: 'err-tok',
      userId: '@bot:example',
      apiBase: mock.url,
    });
    const logged: string[] = [];
    await ch.start(
      async () => { throw new Error('SECRET_DB_DSN=postgres://admin:hunter2@db'); },
      { poll: false, logger: (line: string) => logged.push(line) }
    );

    await ch._simulateInbound(syncWithMessage('!err:example', '@eve:example', 'trigger'));

    const sends = mock.reqs.filter((p) => p.path.includes('/send/m.room.message/'));
    expect(sends).toHaveLength(1);
    const replyText = String(sends[0].body.body);
    expect(replyText).toMatch(/internal error/i);
    expect(replyText).not.toContain('hunter2');
    expect(replyText).not.toContain('SECRET_DB_DSN');
    expect(logged.join('\n')).toContain('hunter2');

    await ch.stop();
    await mock.close();
  });

  test('stop() is idempotent', async () => {
    const { MatrixChannel } = await loadMatrix();
    const ch = new MatrixChannel({
      homeserver: 'https://matrix.example',
      accessToken: '1:x',
      userId: '@bot:example',
      apiBase: 'http://127.0.0.1:1',
    });
    await ch.start(async () => 'r', { poll: false });
    await ch.stop();
    await ch.stop(); // safe to call twice
  });
});
