import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import * as http from 'node:http';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();

// Capture-only mock for slack.com/api. We record every POST and reply
// with a successful chat.postMessage envelope. reactions.add/remove
// can be toggled to test the missing-scope path.
function startMockSlack({ reactionsOk = false } = {}): Promise<{
  url: string;
  posts: Array<{ path: string; body: Record<string, unknown> }>;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c.toString(); });
      req.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* leave empty */ }
        const route = req.url || '';
        posts.push({ path: route, body: parsed });
        res.writeHead(200, { 'content-type': 'application/json' });
        if (route.startsWith('/api/reactions.')) {
          res.end(JSON.stringify({ ok: reactionsOk, error: reactionsOk ? undefined : 'missing_scope' }));
        } else {
          res.end(JSON.stringify({ ok: true, ts: '1700000000.000100', channel: parsed.channel || 'C1' }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/api`,
        posts,
        close: () => new Promise<void>((r) => {
          try { server.closeAllConnections(); } catch { /* node <18 */ }
          server.close(() => r());
        }),
      });
    });
  });
}

async function loadSlack() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'channels', 'slack.mjs')).href;
  return await import(url) as typeof import('../channels/slack.mjs');
}

async function newChannel(apiBase: string) {
  const { SlackChannel } = await loadSlack();
  const ch = new SlackChannel({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    signingSecret: 'sec',
    apiBase,
    requireInbound: true,
  });
  return ch;
}

test.describe('Phase 19.2 — listener channel noise removal', () => {
  test('_ackInbound: reactions:write missing → returns false, posts no text fallback', async () => {
    const mock = await startMockSlack({ reactionsOk: false });
    const ch = await newChannel(mock.url);
    await ch.start(async () => '');

    const eyesOk = await ch._ackInbound('C1', '1700000000.000100');
    expect(eyesOk).toBe(false);

    // Exactly one outbound call (reactions.add attempt). Crucially, no
    // chat.postMessage with the "확인해보겠습니다…" text leaked through.
    expect(mock.posts.map((p) => p.path)).toEqual(['/api/reactions.add']);
    const allTexts = mock.posts.map((p) => p.body.text || '').join('|');
    expect(allTexts).not.toContain('확인해보겠습니다');
    await ch.stop();
    await mock.close();
  });

  test('_ackInbound: reactions:write present → returns true, still no text post', async () => {
    const mock = await startMockSlack({ reactionsOk: true });
    const ch = await newChannel(mock.url);
    await ch.start(async () => '');
    const eyesOk = await ch._ackInbound('C1', '1700000000.000100');
    expect(eyesOk).toBe(true);
    expect(mock.posts.map((p) => p.path)).toEqual(['/api/reactions.add']);
    await ch.stop();
    await mock.close();
  });

  test('_simulateInbound: handler returning null skips the chat.postMessage entirely', async () => {
    const mock = await startMockSlack({ reactionsOk: false });
    const ch = await newChannel(mock.url);
    await ch.start(async () => null);
    await ch._simulateInbound('whatever', 'C1:1700000000.000100');

    // No outbound calls at all — the handler stayed silent and the
    // adapter respected that. Specifically, no "(empty reply)" post.
    expect(mock.posts).toEqual([]);
    await ch.stop();
    await mock.close();
  });

  test('_simulateInbound: handler returning whitespace also stays silent', async () => {
    const mock = await startMockSlack({ reactionsOk: false });
    const ch = await newChannel(mock.url);
    await ch.start(async () => '   \n  \t  ');
    await ch._simulateInbound('msg', 'C1:1700000000.000100');
    expect(mock.posts).toEqual([]);
    await ch.stop();
    await mock.close();
  });

  test('_simulateInbound: handler returning real text DOES post once', async () => {
    const mock = await startMockSlack({ reactionsOk: false });
    const ch = await newChannel(mock.url);
    await ch.start(async () => 'meaningful reply');
    await ch._simulateInbound('msg', 'C1:1700000000.000100');
    expect(mock.posts).toHaveLength(1);
    expect(mock.posts[0].path).toBe('/api/chat.postMessage');
    expect(mock.posts[0].body.text).toBe('meaningful reply');
    await ch.stop();
    await mock.close();
  });
});
