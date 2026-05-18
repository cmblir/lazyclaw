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
    env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir, ...env },
  });
}

// Async CLI runner — required whenever a same-process mock HTTP server
// needs to accept connections WHILE the CLI subprocess is running.
// spawnSync would block the parent event loop and deadlock the mock.
function runCliAsync(args: string[], cfgDir: string, env: NodeJS.ProcessEnv = {}): Promise<{ status: number | null, stdout: string, stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

// In-process mock for slack.com/api so we can verify `conversations.list`
// is called when resolving a `#name` channel during `team add`.
function startMockSlack(channels: Array<{ id: string, name: string }>): Promise<{
  url: string;
  hits: string[];
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url || '');
      // Conversations.list only — that's all teams.mjs hits.
      if ((req.url || '').startsWith('/api/conversations.list')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, channels }));
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/api`,
        hits,
        close: () => new Promise<void>((r) => {
          // closeAllConnections() forces idle keepalive sockets to drop
          // so server.close() resolves promptly. Without it, undici's
          // pooled HTTP/1.1 connections keep the server alive forever
          // and the test hangs at teardown.
          try { server.closeAllConnections(); } catch { /* node <18 */ }
          server.close(() => r());
        }),
      });
    });
  });
}

test.describe('Phase 10 — team registry', () => {
  test('team add stores the record with validated agents and lead', async () => {
    const cfg = tmpDir('p10-add');
    expect(runCli(['agent', 'add', 'planner'], cfg).status).toBe(0);
    expect(runCli(['agent', 'add', 'backend'], cfg).status).toBe(0);
    expect(runCli(['agent', 'add', 'frontend'], cfg).status).toBe(0);

    const r = runCli(['team', 'add', 'shop', '--agents', 'planner,backend,frontend', '--lead', 'planner', '--channel', 'C12345678'], cfg);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({
      name: 'shop',
      displayName: 'Shop',
      agents: ['planner', 'backend', 'frontend'],
      lead: 'planner',
      slackChannel: 'C12345678',
      version: 1,
    });
    const onDisk = JSON.parse(fs.readFileSync(path.join(cfg, 'teams', 'shop.json'), 'utf8'));
    expect(onDisk.lead).toBe('planner');
  });

  test('team add defaults lead to the first agent when --lead omitted', async () => {
    const cfg = tmpDir('p10-defaultlead');
    expect(runCli(['agent', 'add', 'planner'], cfg).status).toBe(0);
    expect(runCli(['agent', 'add', 'backend'], cfg).status).toBe(0);
    const r = runCli(['team', 'add', 'shop', '--agents', 'planner,backend'], cfg);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).lead).toBe('planner');
  });

  test('team add rejects an unregistered agent', async () => {
    const cfg = tmpDir('p10-ghost');
    expect(runCli(['agent', 'add', 'planner'], cfg).status).toBe(0);
    const r = runCli(['team', 'add', 'shop', '--agents', 'planner,ghost'], cfg);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/agent "ghost" is not registered/);
  });

  test('team add rejects a lead that is not in agents', async () => {
    const cfg = tmpDir('p10-badlead');
    expect(runCli(['agent', 'add', 'planner'], cfg).status).toBe(0);
    expect(runCli(['agent', 'add', 'backend'], cfg).status).toBe(0);
    const r = runCli(['team', 'add', 'shop', '--agents', 'planner,backend', '--lead', 'frontend'], cfg);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/lead "frontend" must be one of/);
  });

  test('team add refuses to overwrite an existing team', async () => {
    const cfg = tmpDir('p10-dup');
    expect(runCli(['agent', 'add', 'planner'], cfg).status).toBe(0);
    expect(runCli(['team', 'add', 'shop', '--agents', 'planner'], cfg).status).toBe(0);
    const r = runCli(['team', 'add', 'shop', '--agents', 'planner'], cfg);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/already exists/);
  });

  test('team list returns the JSON array sorted by name', async () => {
    const cfg = tmpDir('p10-list');
    expect(runCli(['agent', 'add', 'a'], cfg).status).toBe(0);
    expect(runCli(['agent', 'add', 'b'], cfg).status).toBe(0);
    expect(runCli(['team', 'add', 'zeta',  '--agents', 'a'], cfg).status).toBe(0);
    expect(runCli(['team', 'add', 'alpha', '--agents', 'b'], cfg).status).toBe(0);
    const r = runCli(['team', 'list'], cfg);
    expect(r.status).toBe(0);
    const arr = JSON.parse(r.stdout);
    expect(arr.map((t: { name: string }) => t.name)).toEqual(['alpha', 'zeta']);
  });

  test('team edit re-validates the agents/lead pair', async () => {
    const cfg = tmpDir('p10-edit');
    expect(runCli(['agent', 'add', 'planner'], cfg).status).toBe(0);
    expect(runCli(['agent', 'add', 'backend'], cfg).status).toBe(0);
    expect(runCli(['team', 'add', 'shop', '--agents', 'planner,backend', '--lead', 'planner'], cfg).status).toBe(0);

    // Edit to drop planner; backend stays — but the on-disk lead is still
    // "planner", which is now invalid → patchTeam must reject.
    const r = runCli(['team', 'edit', 'shop', '--agents', 'backend'], cfg);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/lead "planner" must be one of/);

    // Same edit, but with --lead backend at the same time → success.
    const r2 = runCli(['team', 'edit', 'shop', '--agents', 'backend', '--lead', 'backend'], cfg);
    expect(r2.status).toBe(0);
    expect(JSON.parse(r2.stdout).lead).toBe('backend');
  });

  test('team remove deletes the on-disk record and is idempotent-on-failure', async () => {
    const cfg = tmpDir('p10-remove');
    expect(runCli(['agent', 'add', 'planner'], cfg).status).toBe(0);
    expect(runCli(['team', 'add', 'shop', '--agents', 'planner'], cfg).status).toBe(0);
    expect(fs.existsSync(path.join(cfg, 'teams', 'shop.json'))).toBe(true);

    const r = runCli(['team', 'remove', 'shop'], cfg);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(cfg, 'teams', 'shop.json'))).toBe(false);

    const r2 = runCli(['team', 'remove', 'shop'], cfg);
    expect(r2.status).toBe(2);
    expect(r2.stderr).toMatch(/no team/);
  });

  test('team add resolves #name to the channel id via conversations.list', async () => {
    const mock = await startMockSlack([
      { id: 'C0AA11BB22', name: 'deploys' },
      { id: 'C0CC33DD44', name: 'shop' },
    ]);
    const cfg = tmpDir('p10-resolve');
    expect(runCli(['agent', 'add', 'planner'], cfg).status).toBe(0);

    const r = await runCliAsync(['team', 'add', 'shop', '--agents', 'planner', '--channel', '#deploys'], cfg, {
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_API_BASE: mock.url,
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).slackChannel).toBe('C0AA11BB22');
    expect(mock.hits.some(p => p.startsWith('/api/conversations.list'))).toBe(true);
    await mock.close();
  });

  test('team add falls back to the literal channel when the lookup misses', async () => {
    const mock = await startMockSlack([{ id: 'C9', name: 'deploys' }]);
    const cfg = tmpDir('p10-fallback');
    expect(runCli(['agent', 'add', 'planner'], cfg).status).toBe(0);

    const r = await runCliAsync(['team', 'add', 'shop', '--agents', 'planner', '--channel', '#nothere'], cfg, {
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_API_BASE: mock.url,
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).slackChannel).toBe('#nothere');
    await mock.close();
  });
});
