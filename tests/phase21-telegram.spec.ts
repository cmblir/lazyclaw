import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import * as http from 'node:http';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();

async function loadTelegram() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'channels', 'telegram.mjs')).href;
  return await import(url) as typeof import('../channels/telegram.mjs');
}

// In-process mock for api.telegram.org. The Bot API addresses every
// method as `/bot<TOKEN>/<method>`, so we capture both the request path
// (to assert the token + method) and the parsed JSON body. getUpdates
// returns an empty result by default; sendMessage echoes an ok envelope.
function startMockTelegram(): Promise<{
  url: string;
  posts: Array<{ headers: http.IncomingHttpHeaders; body: any; path: string; method: string }>;
  // Per-method response queue keyed by the bare method name (e.g.
  // 'getUpdates', 'sendMessage'). When empty, sensible defaults apply.
  queue: Record<string, any[]>;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const posts: Array<{ headers: http.IncomingHttpHeaders; body: any; path: string; method: string }> = [];
    const queue: Record<string, any[]> = {};
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c.toString(); });
      req.on('end', () => {
        let parsed: any = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
        const url = req.url || '';
        posts.push({ headers: req.headers, body: parsed, path: url, method: req.method || '' });
        const method = url.split('/').pop() || '';
        const next = (queue[method] || []).shift();
        res.writeHead(200, { 'content-type': 'application/json' });
        if (next !== undefined) { res.end(JSON.stringify(next)); return; }
        if (method === 'sendMessage') {
          res.end(JSON.stringify({ ok: true, result: { message_id: 99, chat: { id: parsed?.chat_id } } }));
          return;
        }
        // Default getUpdates: nothing pending.
        res.end(JSON.stringify({ ok: true, result: [] }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        posts,
        queue,
        close: () => new Promise<void>((r) => {
          try { server.closeAllConnections(); } catch { /* node <18 */ }
          server.close(() => r());
        }),
      });
    });
  });
}

test.describe('Phase 21 — Telegram channel adapter', () => {
  test('start() without a token throws a clear error', async () => {
    const { TelegramChannel } = await loadTelegram();
    const ch = new TelegramChannel({
      token: null,
      apiBase: 'http://127.0.0.1:1',
    });
    let err: any = null;
    try { await ch.start(async () => 'r', { poll: false }); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.code).toBe('TELEGRAM_MISSING_TOKEN');
    expect(String(err.message)).toMatch(/TELEGRAM_BOT_TOKEN/);
  });

  test('token falls back to TELEGRAM_BOT_TOKEN from the environment', async () => {
    const { TelegramChannel } = await loadTelegram();
    const prev = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = '123:env-token';
    try {
      const ch = new TelegramChannel({ apiBase: 'http://127.0.0.1:1' });
      // start() must not throw now that the env supplies the token.
      await ch.start(async () => 'r', { poll: false });
      await ch.stop();
    } finally {
      if (prev === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = prev;
    }
  });

  test('_simulateInbound routes to the handler and posts a reply', async () => {
    const mock = await startMockTelegram();
    const { TelegramChannel } = await loadTelegram();
    const ch = new TelegramChannel({ token: '777:abc', apiBase: mock.url });
    const seen: any[] = [];
    await ch.start(async (evt: any) => { seen.push(evt); return `pong: ${evt.text}`; }, { poll: false });

    await ch._simulateInbound({
      update_id: 1,
      message: { message_id: 5, text: 'hi there', chat: { id: 424242 }, from: { id: 8001 } },
    });

    // Handler observed the normalized event.
    expect(seen).toHaveLength(1);
    expect(seen[0].text).toBe('hi there');
    expect(String(seen[0].threadId)).toContain('424242');
    expect(String(seen[0].senderId)).toBe('8001');

    // Reply posted through sendMessage with the originating chat_id.
    const sends = mock.posts.filter((p) => p.path.endsWith('/sendMessage'));
    expect(sends).toHaveLength(1);
    expect(sends[0].path).toBe('/bot777:abc/sendMessage');
    expect(String(sends[0].body.chat_id)).toBe('424242');
    expect(sends[0].body.text).toBe('pong: hi there');

    await ch.stop();
    await mock.close();
  });

  test('send() POSTs sendMessage with chat_id + text decoded from threadId', async () => {
    const mock = await startMockTelegram();
    const { TelegramChannel } = await loadTelegram();
    const ch = new TelegramChannel({ token: '555:zzz', apiBase: mock.url });
    await ch.start(async () => 'r', { poll: false });

    await ch.send('telegram:909090', 'direct hello');

    const sends = mock.posts.filter((p) => p.path.endsWith('/sendMessage'));
    expect(sends).toHaveLength(1);
    expect(sends[0].method).toBe('POST');
    expect(sends[0].path).toBe('/bot555:zzz/sendMessage');
    expect(String(sends[0].body.chat_id)).toBe('909090');
    expect(sends[0].body.text).toBe('direct hello');

    await ch.stop();
    await mock.close();
  });

  test('pairing allowlist rejects an unknown sender (no handler call, no reply)', async () => {
    const mock = await startMockTelegram();
    const { TelegramChannel } = await loadTelegram();
    const ch = new TelegramChannel({
      token: '111:pair',
      apiBase: mock.url,
      allowlist: ['8001'], // only this Telegram user id may talk to the bot
    });
    let handlerCalls = 0;
    await ch.start(async () => { handlerCalls++; return 'should-not-fire'; }, { poll: false });

    // Sender 9999 is NOT on the allowlist.
    await ch._simulateInbound({
      update_id: 2,
      message: { message_id: 6, text: 'let me in', chat: { id: 13 }, from: { id: 9999 } },
    });

    expect(handlerCalls).toBe(0);
    const sends = mock.posts.filter((p) => p.path.endsWith('/sendMessage'));
    expect(sends).toHaveLength(0);

    // An allowed sender still gets through on the same channel instance.
    await ch._simulateInbound({
      update_id: 3,
      message: { message_id: 7, text: 'i am allowed', chat: { id: 14 }, from: { id: 8001 } },
    });
    expect(handlerCalls).toBe(1);
    const sends2 = mock.posts.filter((p) => p.path.endsWith('/sendMessage'));
    expect(sends2).toHaveLength(1);
    expect(String(sends2[0].body.chat_id)).toBe('14');

    await ch.stop();
    await mock.close();
  });

  test('long-poll consumes getUpdates and dispatches each inbound message', async () => {
    const mock = await startMockTelegram();
    // First getUpdates returns one message; subsequent ones return empty.
    mock.queue.getUpdates = [
      {
        ok: true,
        result: [
          { update_id: 10, message: { message_id: 1, text: 'polled hello', chat: { id: 321 }, from: { id: 4242 } } },
        ],
      },
    ];
    const { TelegramChannel } = await loadTelegram();
    const ch = new TelegramChannel({ token: '999:poll', apiBase: mock.url });
    const seen: any[] = [];
    await ch.start(async (evt: any) => { seen.push(evt); return `ack: ${evt.text}`; }, { poll: true, pollIntervalMs: 5 });

    // Give the poller a few loops to fetch + dispatch + reply.
    const start = Date.now();
    while (seen.length === 0 && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 20));

    expect(seen).toHaveLength(1);
    expect(seen[0].text).toBe('polled hello');

    const updates = mock.posts.filter((p) => p.path.includes('/getUpdates'));
    expect(updates.length).toBeGreaterThanOrEqual(1);
    const sends = mock.posts.filter((p) => p.path.endsWith('/sendMessage'));
    expect(sends).toHaveLength(1);
    expect(String(sends[0].body.chat_id)).toBe('321');
    expect(sends[0].body.text).toBe('ack: polled hello');

    await ch.stop();
    await mock.close();
  });

  test('stop() is idempotent', async () => {
    const { TelegramChannel } = await loadTelegram();
    const ch = new TelegramChannel({ token: '1:x', apiBase: 'http://127.0.0.1:1' });
    await ch.start(async () => 'r', { poll: false });
    await ch.stop();
    await ch.stop(); // safe to call twice
  });

  // FINDING 1 — getUpdates must long-poll. A timeout:0 short-poll hammers
  // the API ~60 req/min while idle. Assert a non-zero long-poll timeout is
  // sent to the Bot API.
  test('getUpdates long-polls with a non-zero timeout', async () => {
    const mock = await startMockTelegram();
    const { TelegramChannel } = await loadTelegram();
    const ch = new TelegramChannel({ token: '999:lp', apiBase: mock.url });
    await ch.start(async () => 'r', { poll: false });

    await ch._fetchUpdates();

    const polls = mock.posts.filter((p) => p.path.includes('/getUpdates'));
    expect(polls).toHaveLength(1);
    expect(typeof polls[0].body.timeout).toBe('number');
    expect(polls[0].body.timeout).toBeGreaterThan(0);

    await ch.stop();
    await mock.close();
  });

  // FINDING 2 — the offset cursor must NOT advance when delivering the
  // reply (send) fails. Otherwise Telegram considers the update acked and
  // the reply is lost forever on the next poll.
  test('offset is not advanced when send() fails for an update', async () => {
    const mock = await startMockTelegram();
    // sendMessage returns an API-level failure so send() throws.
    mock.queue.sendMessage = [{ ok: false, description: 'boom' }];
    const { TelegramChannel } = await loadTelegram();
    const ch = new TelegramChannel({ token: '999:off', apiBase: mock.url });
    await ch.start(async (evt: any) => `reply: ${evt.text}`, { poll: false });

    expect(ch._offset).toBe(0);

    // Drive the poll-loop's single-batch processing directly so loop
    // timing doesn't matter.
    await ch._processBatch([
      { update_id: 42, message: { message_id: 1, text: 'will fail', chat: { id: 7 }, from: { id: 1 } } },
    ]);

    // The update was NOT successfully processed (send threw), so the
    // cursor must stay put — the update will be re-delivered next poll.
    expect(ch._offset).toBe(0);

    await ch.stop();
    await mock.close();
  });

  // FINDING 2 (positive) — a successfully processed batch DOES advance the
  // offset past the highest update_id.
  test('offset advances past the highest update_id after a successful batch', async () => {
    const mock = await startMockTelegram();
    const { TelegramChannel } = await loadTelegram();
    const ch = new TelegramChannel({ token: '999:ok', apiBase: mock.url });
    await ch.start(async () => 'ok', { poll: false });

    await ch._processBatch([
      { update_id: 10, message: { message_id: 1, text: 'a', chat: { id: 7 }, from: { id: 1 } } },
      { update_id: 11, message: { message_id: 2, text: 'b', chat: { id: 7 }, from: { id: 1 } } },
    ]);

    expect(ch._offset).toBe(12);

    await ch.stop();
    await mock.close();
  });

  // FINDING 3 — a gated channel using base.mjs's bucket gate (rate-limit
  // only) keys on the sender id. The gate reads req.token||req.key, so the
  // adapter must pass { key: senderId }; passing { senderId } alone leaves
  // the limiter unkeyed (works) but an authToken gate would deny everyone.
  // Here we exercise a rate-limited gate: capacity 1 lets the first
  // message through and gates the second.
  test('gated channel: rate-limit gate lets first through, gates the second', async () => {
    const mock = await startMockTelegram();
    const { TelegramChannel } = await loadTelegram();
    const { makeBucketGate } = await import(
      pathToFileURL(path.join(REPO_ROOT, 'channels', 'base.mjs')).href
    ) as typeof import('../channels/base.mjs');
    const gate = makeBucketGate({ rateLimit: { capacity: 1, refillPerSec: 0 } });
    const ch = new TelegramChannel({ token: '111:gate', apiBase: mock.url });
    let handlerCalls = 0;
    await ch.start(async (evt: any) => { handlerCalls++; return `ok: ${evt.text}`; }, { poll: false, gate });

    // First message: allowed.
    await ch._simulateInbound({
      update_id: 1,
      message: { message_id: 1, text: 'first', chat: { id: 50 }, from: { id: 8001 } },
    });
    // Second message: bucket empty → gated.
    await ch._simulateInbound({
      update_id: 2,
      message: { message_id: 2, text: 'second', chat: { id: 50 }, from: { id: 8001 } },
    });

    expect(handlerCalls).toBe(1);
    const sends = mock.posts.filter((p) => p.path.endsWith('/sendMessage'));
    expect(sends).toHaveLength(2);
    expect(sends[0].body.text).toBe('ok: first');
    // The gated reply is a generic '(gated: ...)' notice, not the handler.
    expect(String(sends[1].body.text)).toMatch(/gated/);

    await ch.stop();
    await mock.close();
  });

  // FINDING 3 (key passthrough) — the gate input must carry the senderId
  // under the `key` field base.mjs understands. Capture what reaches the
  // gate and assert the key is the sender id.
  test('gated channel: senderId is passed to the gate as `key`', async () => {
    const mock = await startMockTelegram();
    const { TelegramChannel } = await loadTelegram();
    const seenReqs: any[] = [];
    const gate = { check: (req: any) => { seenReqs.push(req); return { ok: true }; } };
    const ch = new TelegramChannel({ token: '111:key', apiBase: mock.url });
    await ch.start(async () => 'r', { poll: false, gate });

    await ch._simulateInbound({
      update_id: 1,
      message: { message_id: 1, text: 'hello', chat: { id: 60 }, from: { id: 7777 } },
    });

    expect(seenReqs).toHaveLength(1);
    expect(String(seenReqs[0].key)).toBe('7777');

    await ch.stop();
    await mock.close();
  });

  // FINDING 4 — an unexpected handler error must NOT echo the internal
  // error message verbatim into the chat (internal-detail leak). The chat
  // gets a generic notice; the detail goes to the logger.
  test('handler error replies a generic notice (no internal detail leak)', async () => {
    const mock = await startMockTelegram();
    const { TelegramChannel } = await loadTelegram();
    const ch = new TelegramChannel({ token: '111:err', apiBase: mock.url });
    const logged: string[] = [];
    await ch.start(
      async () => { throw new Error('SECRET_DB_DSN=postgres://admin:hunter2@db'); },
      { poll: false, logger: (line: string) => logged.push(line) }
    );

    await ch._simulateInbound({
      update_id: 1,
      message: { message_id: 1, text: 'trigger', chat: { id: 70 }, from: { id: 1 } },
    });

    const sends = mock.posts.filter((p) => p.path.endsWith('/sendMessage'));
    expect(sends).toHaveLength(1);
    const replyText = String(sends[0].body.text);
    // Generic, and must not contain the secret-bearing internal message.
    expect(replyText).toMatch(/internal error/i);
    expect(replyText).not.toContain('hunter2');
    expect(replyText).not.toContain('SECRET_DB_DSN');
    // Full detail still reaches the diagnostic sink.
    expect(logged.join('\n')).toContain('hunter2');

    await ch.stop();
    await mock.close();
  });
});
