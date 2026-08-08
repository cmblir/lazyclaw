import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

const REPO_ROOT = process.cwd();
const CLI = path.join(REPO_ROOT, 'cli.mjs');

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lc-${prefix}-`));
}

function runCli(args: string[], cfgDir: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, POMPOS_CONFIG_DIR: cfgDir, ...env },
  });
}

function runCliAsync(args: string[], cfgDir: string, env: NodeJS.ProcessEnv = {}): Promise<{ status: number | null, stdout: string, stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, POMPOS_CONFIG_DIR: cfgDir, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

// chat.postMessage mock — echoes back a deterministic ts so the task
// record assertion knows what to expect.
function startMockSlack(replyTs = '1700000000.000100'): Promise<{
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
        res.end(JSON.stringify({ ok: true, ts: replyTs, channel: parsed?.channel || 'C0' }));
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

async function seedTeam(cfg: string, opts: { channel?: string } = {}) {
  expect(runCli(['agent', 'add', 'planner', '--display', 'Planner agent'], cfg).status).toBe(0);
  expect(runCli(['agent', 'add', 'backend'], cfg).status).toBe(0);
  const args = ['team', 'add', 'shop', '--agents', 'planner,backend', '--lead', 'planner', '--display', 'Shop squad'];
  if (opts.channel) args.push('--channel', opts.channel);
  expect(runCli(args, cfg).status).toBe(0);
}

test.describe('Phase 11 — task start', () => {
  test('task start without a team channel records pending status and skips Slack', async () => {
    const cfg = tmpDir('p11-nochannel');
    await seedTeam(cfg);
    const r = runCli(['task', 'start', '--team', 'shop', '--title', 'ship checkout flow', '--description', 'MVP'], cfg);
    expect(r.status).toBe(0);
    const task = JSON.parse(r.stdout);
    expect(task).toMatchObject({
      team: 'shop',
      lead: 'planner',
      status: 'pending',
      slackChannel: '',
      slackThreadTs: '',
      title: 'ship checkout flow',
      description: 'MVP',
      version: 1,
    });
    expect(task.id).toMatch(/^t_\d{8}_[a-z0-9]{6}$/);
    expect(task.turns).toEqual([]);
    expect(r.stderr).toMatch(/no slackChannel/);
  });

  test('task start with a team channel posts to Slack and stores the thread ts', async () => {
    const mock = await startMockSlack('1700000000.999000');
    const cfg = tmpDir('p11-post');
    await seedTeam(cfg, { channel: 'C12345678' });

    const r = await runCliAsync(['task', 'start', '--team', 'shop', '--title', 'ship checkout flow'], cfg, {
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_API_BASE: mock.url,
    });
    expect(r.status).toBe(0);
    const task = JSON.parse(r.stdout);
    expect(task.slackChannel).toBe('C12345678');
    expect(task.slackThreadTs).toBe('1700000000.999000');
    expect(task.status).toBe('running');
    expect(task.turns).toHaveLength(1);
    expect(task.turns[0]).toMatchObject({ agent: 'system', ts: '1700000000.999000' });

    expect(mock.posts).toHaveLength(1);
    expect(mock.posts[0].path).toBe('/api/chat.postMessage');
    expect(mock.posts[0].body.channel).toBe('C12345678');
    expect(mock.posts[0].body.text).toContain('ship checkout flow');
    expect(mock.posts[0].body.text).toContain('*Planner agent*');
    await mock.close();
  });

  test('task start rejects an unknown team', async () => {
    const cfg = tmpDir('p11-noteam');
    const r = runCli(['task', 'start', '--team', 'ghost', '--title', 'x'], cfg);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no team "ghost"/);
  });

  test('task start rejects a lead that is not in the team', async () => {
    const cfg = tmpDir('p11-badlead');
    await seedTeam(cfg);
    const r = runCli(['task', 'start', '--team', 'shop', '--title', 'x', '--lead', 'frontend'], cfg);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/lead "frontend" is not in team/);
  });

  test('task start rejects a missing title', async () => {
    const cfg = tmpDir('p11-notitle');
    await seedTeam(cfg);
    const r = runCli(['task', 'start', '--team', 'shop'], cfg);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Usage: pompos task start/);
  });

  test('task list returns the JSON array sorted newest-first', async () => {
    const cfg = tmpDir('p11-list');
    await seedTeam(cfg);
    const a = JSON.parse(runCli(['task', 'start', '--team', 'shop', '--title', 'first'], cfg).stdout);
    // Force a millisecond gap so createdAt strings actually differ.
    await new Promise(r => setTimeout(r, 10));
    const b = JSON.parse(runCli(['task', 'start', '--team', 'shop', '--title', 'second'], cfg).stdout);

    const r = runCli(['task', 'list'], cfg);
    expect(r.status).toBe(0);
    const arr = JSON.parse(r.stdout);
    expect(arr.map((t: { id: string }) => t.id)).toEqual([b.id, a.id]);
  });

  test('task done sets status and posts a closing message to the thread', async () => {
    const mock = await startMockSlack('1700000000.000111');
    const cfg = tmpDir('p11-done');
    await seedTeam(cfg, { channel: 'C12345678' });

    const r1 = await runCliAsync(['task', 'start', '--team', 'shop', '--title', 'cleanup'], cfg, {
      SLACK_BOT_TOKEN: 'xoxb-test', SLACK_API_BASE: mock.url,
    });
    expect(r1.status).toBe(0);
    const opened = JSON.parse(r1.stdout);

    const r2 = await runCliAsync(['task', 'done', opened.id], cfg, {
      SLACK_BOT_TOKEN: 'xoxb-test', SLACK_API_BASE: mock.url,
    });
    expect(r2.status).toBe(0);
    expect(JSON.parse(r2.stdout).status).toBe('done');

    expect(mock.posts).toHaveLength(2);
    expect(mock.posts[1].body.thread_ts).toBe('1700000000.000111');
    expect(mock.posts[1].body.text).toMatch(/marked done/);
    await mock.close();
  });

  test('task abandon flips status and posts closing message', async () => {
    const mock = await startMockSlack('1700000000.000222');
    const cfg = tmpDir('p11-abandon');
    await seedTeam(cfg, { channel: 'C12345678' });

    const r1 = await runCliAsync(['task', 'start', '--team', 'shop', '--title', 'wip'], cfg, {
      SLACK_BOT_TOKEN: 'xoxb-test', SLACK_API_BASE: mock.url,
    });
    const opened = JSON.parse(r1.stdout);

    const r2 = await runCliAsync(['task', 'abandon', opened.id], cfg, {
      SLACK_BOT_TOKEN: 'xoxb-test', SLACK_API_BASE: mock.url,
    });
    expect(r2.status).toBe(0);
    expect(JSON.parse(r2.stdout).status).toBe('abandoned');
    expect(mock.posts).toHaveLength(2);
    expect(mock.posts[1].body.text).toMatch(/abandoned/);
    await mock.close();
  });

  test('task show / remove behave correctly', async () => {
    const cfg = tmpDir('p11-showrm');
    await seedTeam(cfg);
    const opened = JSON.parse(runCli(['task', 'start', '--team', 'shop', '--title', 'x'], cfg).stdout);

    const r1 = runCli(['task', 'show', opened.id], cfg);
    expect(r1.status).toBe(0);
    expect(JSON.parse(r1.stdout).id).toBe(opened.id);

    const r2 = runCli(['task', 'remove', opened.id], cfg);
    expect(r2.status).toBe(0);
    expect(fs.existsSync(path.join(cfg, 'tasks', `${opened.id}.json`))).toBe(false);

    const r3 = runCli(['task', 'show', opened.id], cfg);
    expect(r3.status).toBe(2);
    expect(r3.stderr).toMatch(/no task/);
  });
});
