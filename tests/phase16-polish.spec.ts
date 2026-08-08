import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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

interface Daemon {
  port: number;
  baseUrl: string;
  child: ChildProcessWithoutNullStreams;
  stop: () => Promise<void>;
}
async function startDaemon(cfgDir: string): Promise<Daemon> {
  const child = spawn(process.execPath, [CLI, 'daemon', '--port', '0'], {
    env: { ...process.env, POMPOS_CONFIG_DIR: cfgDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let port = 0;
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    const nl = buf.indexOf('\n');
    if (nl >= 0 && !port) {
      try { const j = JSON.parse(buf.slice(0, nl)); if (j.port) port = j.port; } catch { /* skip */ }
    }
  });
  const start = Date.now();
  while (!port && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 50));
  if (!port) { child.kill('SIGKILL'); throw new Error('daemon never bound a port'); }
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    stop: () => new Promise<void>((resolve) => {
      child.on('close', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 3000);
    }),
  };
}

test.describe('Phase 16 — polish: avatar, typing placeholder, transcript export', () => {
  test('agent record carries iconEmoji through registerAgent + listAgents', async () => {
    const cfg = tmpDir('p16-icon');
    const r = runCli(['agent', 'add', 'planner', '--provider', 'anthropic'], cfg);
    expect(r.status).toBe(0);
    // The CLI doesn't expose --icon yet (would come from the dashboard),
    // so we go through the module directly to keep the registry test
    // focused.
    const url = pathToFileURL(path.join(REPO_ROOT, 'agents.mjs')).href;
    const mod = await import(url) as typeof import('../agents.mjs');
    const patched = mod.patchAgent('planner', { iconEmoji: ':robot_face:' }, cfg);
    expect(patched.iconEmoji).toBe(':robot_face:');
  });

  test('SlackChannel.send threads username + icon_emoji through chat.postMessage when given', async () => {
    // Capture-only mock — record whatever chat.postMessage gets.
    const posts: Array<{ body: Record<string, unknown> }> = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c.toString(); });
      req.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* skip */ }
        posts.push({ body: parsed });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ts: '1700000000.000100', channel: 'C1' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const apiBase = `http://127.0.0.1:${port}/api`;

    const slackUrl = pathToFileURL(path.join(REPO_ROOT, 'channels', 'slack.mjs')).href;
    const { SlackChannel } = await import(slackUrl);
    const ch = new SlackChannel({ botToken: 'xoxb-test', appToken: 'xapp-x', signingSecret: 'sec', apiBase, requireInbound: false });
    await ch.start(async () => '');

    await ch.send('C1:1700000000.000100', 'hello', { username: 'Planner', icon_emoji: ':rocket:' });
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({
      channel: 'C1',
      text: 'hello',
      thread_ts: '1700000000.000100',
      username: 'Planner',
      icon_emoji: ':rocket:',
    });

    await ch.stop();
    await new Promise<void>((r) => {
      try { server.closeAllConnections(); } catch { /* node <18 */ }
      server.close(() => r());
    });
  });

  test('formatTranscript renders text / md / json variants', async () => {
    const url = pathToFileURL(path.join(REPO_ROOT, 'tasks.mjs')).href;
    const mod = await import(url) as typeof import('../tasks.mjs');
    const task = {
      version: 1, id: 't_20260518_polish', title: 'ship', description: 'mvp',
      team: 'shop', lead: 'planner', status: 'done',
      slackChannel: 'C1', slackThreadTs: '1700.0',
      createdAt: '', updatedAt: '',
      turns: [
        { agent: 'user',    text: 'do it', ts: 't1' },
        { agent: 'planner', text: 'plan ready', ts: 't2', toolCalls: [{ id: '1', name: 'bash', input: { command: 'ls' }, ok: true }] },
        { agent: 'planner', text: 'all done [[TASK_DONE]]', ts: 't3' },
      ],
    };

    const txt = mod.formatTranscript(task, 'text');
    expect(txt).toContain('Task t_20260518_polish');
    expect(txt).toContain('[User]');
    expect(txt).toContain('[planner]');
    expect(txt).toContain('all done [[TASK_DONE]]');

    const md = mod.formatTranscript(task, 'md');
    expect(md).toMatch(/^# Task `t_20260518_polish`/);
    expect(md).toContain('### planner');
    expect(md).toContain('```json');
    expect(md).toContain('"tool": "bash"');

    const json = mod.formatTranscript(task, 'json');
    expect(JSON.parse(json).id).toBe('t_20260518_polish');
  });

  test('pompos task transcript prints the rendered text by default and JSON with --format json', async () => {
    const cfg = tmpDir('p16-cli-transcript');
    expect(runCli(['agent', 'add', 'planner'], cfg).status).toBe(0);
    expect(runCli(['team',  'add', 'shop',   '--agents', 'planner'], cfg).status).toBe(0);
    const opened = JSON.parse(runCli(['task', 'start', '--team', 'shop', '--title', 'wrap'], cfg).stdout);

    const txt = runCli(['task', 'transcript', opened.id], cfg);
    expect(txt.status).toBe(0);
    expect(txt.stdout).toContain(`Task ${opened.id}`);
    expect(txt.stdout).toContain('Team: shop');

    const md = runCli(['task', 'transcript', opened.id, '--format', 'md'], cfg);
    expect(md.status).toBe(0);
    expect(md.stdout).toMatch(/^# Task `/);

    const j = runCli(['task', 'transcript', opened.id, '--format', 'json'], cfg);
    expect(j.status).toBe(0);
    expect(JSON.parse(j.stdout).id).toBe(opened.id);
  });

  test('daemon GET /tasks/<id>/transcript returns text/markdown/json by query param', async () => {
    const cfg = tmpDir('p16-daemon-transcript');
    expect(runCli(['agent', 'add', 'planner'], cfg).status).toBe(0);
    expect(runCli(['team',  'add', 'shop',   '--agents', 'planner'], cfg).status).toBe(0);
    const opened = JSON.parse(runCli(['task', 'start', '--team', 'shop', '--title', 'serve'], cfg).stdout);

    const d = await startDaemon(cfg);
    try {
      const rText = await fetch(`${d.baseUrl}/tasks/${opened.id}/transcript`);
      expect(rText.ok).toBe(true);
      expect(rText.headers.get('content-type')).toMatch(/text\/plain/);
      expect(await rText.text()).toContain(`Task ${opened.id}`);

      const rMd = await fetch(`${d.baseUrl}/tasks/${opened.id}/transcript?format=md`);
      expect(rMd.ok).toBe(true);
      expect(rMd.headers.get('content-type')).toMatch(/text\/markdown/);
      expect(await rMd.text()).toMatch(/^# Task `/);

      const rJson = await fetch(`${d.baseUrl}/tasks/${opened.id}/transcript?format=json`);
      expect(rJson.ok).toBe(true);
      expect(rJson.headers.get('content-type')).toMatch(/application\/json/);
      expect((await rJson.json()).id).toBe(opened.id);

      const r404 = await fetch(`${d.baseUrl}/tasks/t_20260518_aaaaaa/transcript`);
      expect(r404.status).toBe(404);
    } finally { await d.stop(); }
  });
});
