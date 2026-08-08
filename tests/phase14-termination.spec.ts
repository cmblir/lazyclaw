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

interface Response { status?: number; json: Record<string, unknown>; }
function startMockAnthropic(): Promise<{
  baseUrl: string;
  queue: Response[];
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const queue: Response[] = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c.toString(); });
      req.on('end', () => {
        const next = queue.shift();
        if (!next) { res.writeHead(500); res.end('queue empty'); return; }
        res.writeHead(next.status || 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(next.json));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        queue,
        close: () => new Promise<void>((r) => {
          try { server.closeAllConnections(); } catch { /* node <18 */ }
          server.close(() => r());
        }),
      });
    });
  });
}

async function loadRouter() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'mas', 'mention_router.mjs')).href;
  return await import(url) as typeof import('../mas/mention_router.mjs');
}

function makeAgent(name: string) {
  return {
    version: 1, name,
    displayName: name,
    role: '',
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    tools: ['bash', 'read', 'write', 'grep'],
    tags: [], createdAt: '', updatedAt: '',
  };
}

function seedTaskFile(cfgDir: string, overrides: Record<string, unknown>) {
  fs.mkdirSync(path.join(cfgDir, 'tasks'), { recursive: true });
  const id = overrides.id as string;
  const task = {
    version: 1, id,
    title: 'wrap up', description: '', team: 'shop', lead: 'planner',
    status: 'running', slackChannel: '', slackThreadTs: '',
    createdAt: '', updatedAt: '', turns: [],
    ...overrides,
  };
  fs.writeFileSync(path.join(cfgDir, 'tasks', `${id}.json`), JSON.stringify(task, null, 2));
  return task;
}

test.describe('Phase 14 — termination policies', () => {
  test('runTaskTurn refuses to run on a task with status=done', async () => {
    const cfgDir = tmpDir('p14-done');
    const task = seedTaskFile(cfgDir, { id: 't_20260518_term01', status: 'done' });
    const { runTaskTurn } = await loadRouter();
    let err: Error & { code?: string } | null = null;
    try {
      await runTaskTurn({
        task,
        team: { name: 'shop', displayName: 'shop', agents: ['planner'], lead: 'planner', slackChannel: '' },
        agentsById: { planner: makeAgent('planner') },
        userMessage: 'more',
        configDir: cfgDir,
        apiKey: 'sk-test',
      });
    } catch (e) { err = e as Error & { code?: string }; }
    expect(err).toBeTruthy();
    expect(err!.code).toBe('ROUTER_CLOSED');
  });

  test('runTaskTurn refuses to run on a task with status=abandoned', async () => {
    const cfgDir = tmpDir('p14-abandoned');
    const task = seedTaskFile(cfgDir, { id: 't_20260518_term02', status: 'abandoned' });
    const { runTaskTurn } = await loadRouter();
    let err: Error & { code?: string } | null = null;
    try {
      await runTaskTurn({
        task,
        team: { name: 'shop', displayName: 'shop', agents: ['planner'], lead: 'planner', slackChannel: '' },
        agentsById: { planner: makeAgent('planner') },
        userMessage: 'more',
        configDir: cfgDir,
        apiKey: 'sk-test',
      });
    } catch (e) { err = e as Error & { code?: string }; }
    expect(err!.code).toBe('ROUTER_CLOSED');
  });

  test('[[TASK_DONE]] termination flow end-to-end through the CLI', async () => {
    const mock = await startMockAnthropic();
    mock.queue.push({
      json: {
        id: 'm1', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'all set [[TASK_DONE]]' }],
        stop_reason: 'end_turn',
      },
    });

    const cfg = tmpDir('p14-cli-done');
    expect(runCli(['agent', 'add', 'planner', '--provider', 'anthropic'], cfg).status).toBe(0);
    expect(runCli(['team',  'add', 'shop',   '--agents', 'planner'], cfg).status).toBe(0);
    expect(runCli(['auth',  'add', 'anthropic', 'sk-test', '--label', 'm'], cfg).status).toBe(0);
    expect(runCli(['auth',  'use', 'anthropic', 'm'], cfg).status).toBe(0);
    const open = JSON.parse(runCli(['task', 'start', '--team', 'shop', '--title', 'x'], cfg).stdout);

    const r = await runCliAsync(['task', 'tick', open.id, 'go'], cfg, { POMPOS_ANTHROPIC_BASE_URL: mock.baseUrl });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).stoppedBy).toBe('done');

    // A second tick after termination must exit non-zero with ROUTER_CLOSED.
    const r2 = await runCliAsync(['task', 'tick', open.id, 'more'], cfg, { POMPOS_ANTHROPIC_BASE_URL: mock.baseUrl });
    expect(r2.status).toBe(2);
    expect(r2.stderr).toMatch(/ROUTER_CLOSED|done — cannot run/);
    await mock.close();
  });

  test('manual pompos task abandon stops future ticks even when the task was running', async () => {
    const mock = await startMockAnthropic();
    // First tick: agent keeps mentioning itself so we'd burn budget if
    // the second tick were allowed.
    mock.queue.push({
      json: {
        id: 'm1', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'working… @planner more' }],
        stop_reason: 'end_turn',
      },
    });

    const cfg = tmpDir('p14-abandon');
    expect(runCli(['agent', 'add', 'planner', '--provider', 'anthropic'], cfg).status).toBe(0);
    expect(runCli(['team',  'add', 'shop',   '--agents', 'planner'], cfg).status).toBe(0);
    expect(runCli(['auth',  'add', 'anthropic', 'sk-test', '--label', 'm'], cfg).status).toBe(0);
    expect(runCli(['auth',  'use', 'anthropic', 'm'], cfg).status).toBe(0);
    const open = JSON.parse(runCli(['task', 'start', '--team', 'shop', '--title', 'loop'], cfg).stdout);

    // Tick once to take a budget hit, then abandon, then verify a third
    // tick is refused. The first tick uses --max-turns 1 so we don't
    // need to feed a long mock queue.
    const t1 = await runCliAsync(['task', 'tick', open.id, 'go', '--max-turns', '1'], cfg, { POMPOS_ANTHROPIC_BASE_URL: mock.baseUrl });
    expect(t1.status).toBe(0);
    expect(JSON.parse(t1.stdout).stoppedBy).toBe('budget');

    const ab = runCli(['task', 'abandon', open.id], cfg);
    expect(ab.status).toBe(0);
    expect(JSON.parse(ab.stdout).status).toBe('abandoned');

    const t2 = await runCliAsync(['task', 'tick', open.id, 'more'], cfg, { POMPOS_ANTHROPIC_BASE_URL: mock.baseUrl });
    expect(t2.status).toBe(2);
    expect(t2.stderr).toMatch(/abandoned/);
    await mock.close();
  });

  test('a ping-pong handoff that never says DONE eventually hits the iteration budget', async () => {
    const mock = await startMockAnthropic();
    // planner mentions backend, backend mentions planner, forever. The
    // router's queue never drains so we should hit the budget cap.
    for (let i = 0; i < 8; i++) {
      mock.queue.push({
        json: {
          id: `m${i}`, type: 'message', role: 'assistant',
          content: [{ type: 'text', text: i % 2 === 0 ? '@backend continue' : '@planner more' }],
          stop_reason: 'end_turn',
        },
      });
    }

    const cfg = tmpDir('p14-budget-cli');
    expect(runCli(['agent', 'add', 'planner', '--provider', 'anthropic'], cfg).status).toBe(0);
    expect(runCli(['agent', 'add', 'backend', '--provider', 'anthropic'], cfg).status).toBe(0);
    expect(runCli(['team',  'add', 'shop',   '--agents', 'planner,backend', '--lead', 'planner'], cfg).status).toBe(0);
    expect(runCli(['auth',  'add', 'anthropic', 'sk-test', '--label', 'm'], cfg).status).toBe(0);
    expect(runCli(['auth',  'use', 'anthropic', 'm'], cfg).status).toBe(0);
    const open = JSON.parse(runCli(['task', 'start', '--team', 'shop', '--title', 'forever'], cfg).stdout);

    const r = await runCliAsync(['task', 'tick', open.id, 'spin', '--max-turns', '4'], cfg, { POMPOS_ANTHROPIC_BASE_URL: mock.baseUrl });
    expect(r.status).toBe(0);
    const summary = JSON.parse(r.stdout);
    expect(summary.stoppedBy).toBe('budget');
    expect(summary.iterations).toBe(4);
    // Hitting the turn budget is a pause, not a failure: the task lands on
    // 'paused' (resumable — `task tick` flips it back to running, or the user
    // can abandon it). It is NOT left perpetually 'running'.
    const onDisk = JSON.parse(fs.readFileSync(path.join(cfg, 'tasks', `${open.id}.json`), 'utf8'));
    expect(onDisk.status).toBe('paused');
    await mock.close();
  });

  test('a quiet (mention-less) lead turn ends naturally with stoppedBy=idle', async () => {
    // This documents the design choice: when the lead emits a turn
    // without any @mention AND without DONE, the queue empties on its
    // own — that's "idle", not "budget". The user can tick again or
    // abandon, but the router doesn't keep spending budget on a quiet
    // model.
    const mock = await startMockAnthropic();
    mock.queue.push({
      json: { id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'I am thinking' }], stop_reason: 'end_turn' },
    });

    const cfg = tmpDir('p14-idle');
    expect(runCli(['agent', 'add', 'planner', '--provider', 'anthropic'], cfg).status).toBe(0);
    expect(runCli(['team',  'add', 'shop',   '--agents', 'planner'], cfg).status).toBe(0);
    expect(runCli(['auth',  'add', 'anthropic', 'sk-test', '--label', 'm'], cfg).status).toBe(0);
    expect(runCli(['auth',  'use', 'anthropic', 'm'], cfg).status).toBe(0);
    const open = JSON.parse(runCli(['task', 'start', '--team', 'shop', '--title', 'quiet'], cfg).stdout);

    const r = await runCliAsync(['task', 'tick', open.id, 'go'], cfg, { POMPOS_ANTHROPIC_BASE_URL: mock.baseUrl });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).stoppedBy).toBe('idle');
    // Idle is a pause, not a failure → 'paused' (resumable via `task tick`).
    const onDisk = JSON.parse(fs.readFileSync(path.join(cfg, 'tasks', `${open.id}.json`), 'utf8'));
    expect(onDisk.status).toBe('paused');
    await mock.close();
  });
});
