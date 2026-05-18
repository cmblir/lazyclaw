import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();
const CLI = path.join(REPO_ROOT, 'cli.mjs');

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lc-${prefix}-`));
}

function runCli(args: string[], cfgDir: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir, LAZYCLAW_SKIP_CRON_INSTALL: '1', ...env },
  });
}

// Async variant — leaves the test process's event loop free so an
// in-process mock HTTP server can accept connections while the CLI
// subprocess is running. spawnSync would deadlock here.
function runCliAsync(args: string[], cfgDir: string, env: NodeJS.ProcessEnv = {}): Promise<{ status: number | null, stdout: string, stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir, LAZYCLAW_SKIP_CRON_INSTALL: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

// In-process mock for slack.com/api. Captures every chat.postMessage
// call so the test can assert payload shape and target channel.
function startMockSlack(): Promise<{
  url: string;
  posts: Array<{ headers: http.IncomingHttpHeaders; body: any; path: string }>;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const posts: Array<{ headers: http.IncomingHttpHeaders; body: any; path: string }> = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c.toString(); });
      req.on('end', () => {
        let parsed: any = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
        posts.push({ headers: req.headers, body: parsed, path: req.url || '' });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ts: '1700000000.000100', channel: 'C123' }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/api`,
        posts,
        close: () => new Promise<void>(r => server.close(() => r())),
      });
    });
  });
}

test.describe('Phase 8 — Slack adapter', () => {
  test('start() without env vars throws with a clear missing-secrets error', async () => {
    const slackUrl = pathToFileURL(path.join(REPO_ROOT, 'channels', 'slack.mjs')).href;
    const { SlackChannel } = await import(slackUrl);
    const ch = new SlackChannel({
      botToken: null, appToken: null, signingSecret: null,
      apiBase: 'http://127.0.0.1:1', requireInbound: true,
    });
    let err: any = null;
    try { await ch.start(async () => 'r'); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.code).toBe('SLACK_MISSING_ENV');
    // Tokens list must surface so the operator knows what to provision.
    expect(err.missing).toContain('SLACK_BOT_TOKEN');
    expect(err.missing).toContain('SLACK_APP_TOKEN');
    expect(err.missing).toContain('SLACK_SIGNING_SECRET');
  });

  test('inbound _simulateInbound runs handler and posts reply via Web API', async () => {
    const mock = await startMockSlack();
    const slackUrl = pathToFileURL(path.join(REPO_ROOT, 'channels', 'slack.mjs')).href;
    const { SlackChannel } = await import(slackUrl);
    const ch = new SlackChannel({
      botToken: 'xoxb-test', appToken: 'xapp-test', signingSecret: 'sec',
      apiBase: mock.url, requireInbound: true,
    });
    await ch.start(async ({ text }: { text: string }) => `pong: ${text}`);
    await ch._simulateInbound('@lazyclaw hi', 'C999:1700000000.000100');
    expect(mock.posts).toHaveLength(1);
    expect(mock.posts[0].path).toBe('/api/chat.postMessage');
    expect(mock.posts[0].headers.authorization).toBe('Bearer xoxb-test');
    expect(mock.posts[0].body.channel).toBe('C999');
    expect(mock.posts[0].body.thread_ts).toBe('1700000000.000100');
    expect(mock.posts[0].body.text).toBe('pong: @lazyclaw hi');
    await ch.stop();
    await mock.close();
  });

  test('goal tick with channels: ["slack:#test"] posts the check-in', async () => {
    const mock = await startMockSlack();
    const cfg = tmpDir('p8-tick');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);
    expect(runCli(['goal', 'add', 'ship', '--desc', 'ship it', '--channel', 'slack:#test'], cfg).status).toBe(0);

    const r = await runCliAsync(['goal', 'tick', 'ship', '--force'], cfg, {
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_API_BASE: mock.url,
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.fanout).toHaveLength(1);
    expect(out.fanout[0]).toMatchObject({ channel: 'slack:#test', ok: true });
    expect(mock.posts).toHaveLength(1);
    expect(mock.posts[0].body.channel).toBe('#test');
    expect(mock.posts[0].body.text).toContain('mock-reply');
    await mock.close();
  });

  test('goal without channels does NOT post anywhere even when SLACK env is set', async () => {
    const mock = await startMockSlack();
    const cfg = tmpDir('p8-nochannels');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);
    expect(runCli(['goal', 'add', 'quiet', '--desc', 'no channel'], cfg).status).toBe(0);

    const r = await runCliAsync(['goal', 'tick', 'quiet', '--force'], cfg, {
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_API_BASE: mock.url,
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.fanout).toHaveLength(0);
    expect(mock.posts).toHaveLength(0);
    await mock.close();
  });

  test('goal channel remove strips the target — next tick does not post', async () => {
    const mock = await startMockSlack();
    const cfg = tmpDir('p8-remove');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);
    expect(runCli(['goal', 'add', 'gone', '--desc', 'x', '--channel', 'slack:#test'], cfg).status).toBe(0);
    const r1 = await runCliAsync(['goal', 'tick', 'gone', '--force'], cfg, { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_API_BASE: mock.url });
    expect(r1.status).toBe(0);
    expect(JSON.parse(r1.stdout).fanout).toHaveLength(1);

    expect(runCli(['goal', 'channel', 'remove', 'gone', 'slack:#test'], cfg).status).toBe(0);

    const r2 = await runCliAsync(['goal', 'tick', 'gone', '--force'], cfg, { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_API_BASE: mock.url });
    expect(r2.status).toBe(0);
    expect(JSON.parse(r2.stdout).fanout).toHaveLength(0);

    // Total posts captured: only the first run's one — the second tick
    // should NOT have hit Slack at all.
    expect(mock.posts).toHaveLength(1);
    await mock.close();
  });
});
