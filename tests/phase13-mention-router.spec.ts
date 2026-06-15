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
    env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir, ...env },
  });
}

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

interface Response { status?: number; json: Record<string, unknown>; }
function startMockAnthropic(): Promise<{
  baseUrl: string;
  queue: Response[];
  posts: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }>;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const queue: Response[] = [];
    const posts: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c.toString(); });
      req.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* leave empty */ }
        posts.push({ headers: req.headers, body: parsed });
        const next = queue.shift();
        if (!next) {
          res.writeHead(500); res.end('queue empty'); return;
        }
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
        posts,
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

function makeAgent(name: string, role: string) {
  return {
    version: 1,
    name,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    role,
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    tools: ['bash', 'read', 'write', 'grep'],
    tags: [],
    createdAt: '', updatedAt: '',
  };
}

function makeTeam(name: string, agents: string[], lead: string) {
  return {
    version: 1,
    name,
    displayName: name,
    agents,
    lead,
    slackChannel: '',   // disable Slack post in tests
    createdAt: '', updatedAt: '',
  };
}

function makeTask(team: string, lead: string) {
  return {
    version: 1,
    id: 't_20260518_rout01',
    title: 'ship checkout flow',
    description: 'MVP',
    team,
    lead,
    status: 'running',
    slackChannel: '',
    slackThreadTs: '',
    createdAt: '', updatedAt: '',
    turns: [],
  };
}

test.describe('Phase 13 — mention router', () => {
  test('extractMentions resolves only registered teammates, dedupes, and skips the speaker', async () => {
    const { extractMentions } = await loadRouter();
    const team = ['planner', 'backend', 'frontend'];

    expect(extractMentions('@planner please review', team)).toEqual(['planner']);
    expect(extractMentions('cc @backend and @frontend now', team)).toEqual(['backend', 'frontend']);
    expect(extractMentions('@ghost is not real', team)).toEqual([]);
    expect(extractMentions('@backend @backend @backend', team)).toEqual(['backend']);
    expect(extractMentions('@planner do X', team, 'planner')).toEqual([]);  // self-mention skipped
    expect(extractMentions('email me at foo@bar.com', team)).toEqual([]);   // not a word-start @
  });

  test('renderTranscript collapses turns into a "[Who] text" stream', async () => {
    const { renderTranscript } = await loadRouter();
    const out = renderTranscript([
      { agent: 'user',     text: 'do X' },
      { agent: 'planner',  text: 'plan' },
      { agent: 'system',   text: 'open' },
    ]);
    expect(out).toContain('[User] do X');
    expect(out).toContain('[planner] plan');
    expect(out).toContain('[System] open');
  });

  test('lead solo turn terminates the task when the reply contains [[TASK_DONE]]', async () => {
    const cfgDir = tmpDir('p13-solo');
    fs.mkdirSync(path.join(cfgDir, 'tasks'), { recursive: true });
    // We need an on-disk task record because the router patches via tasks.mjs.
    const task = makeTask('shop', 'planner');
    fs.writeFileSync(path.join(cfgDir, 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2));

    const mock = await startMockAnthropic();
    mock.queue.push({
      json: {
        id: 'msg_1', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'all clear [[TASK_DONE]]' }],
        stop_reason: 'end_turn',
      },
    });

    const { runTaskTurn } = await loadRouter();
    const r = await runTaskTurn({
      task,
      team: makeTeam('shop', ['planner', 'backend'], 'planner'),
      agentsById: {
        planner: makeAgent('planner', 'You are the planner.'),
        backend: makeAgent('backend', 'You are the backend.'),
      },
      userMessage: 'go',
      configDir: cfgDir,
      apiKey: 'sk-test',
      baseUrl: mock.baseUrl,
    });
    expect(r.stoppedBy).toBe('done');
    expect(r.iterations).toBe(1);
    expect(r.task.status).toBe('done');
    const turns = r.task.turns;
    expect(turns).toHaveLength(2);
    expect(turns[0].agent).toBe('user');
    expect(turns[1].agent).toBe('planner');
    expect(turns[1].text).toContain('[[TASK_DONE]]');
    await mock.close();
  });

  test('E3 — runTaskTurn reuses one provided Slack sender and never stops it', async () => {
    const cfgDir = tmpDir('p13-slack-reuse');
    fs.mkdirSync(path.join(cfgDir, 'tasks'), { recursive: true });
    // A task WITH a live Slack thread so the post path actually runs.
    const task = { ...makeTask('shop', 'planner'), slackChannel: 'C123', slackThreadTs: '1700000000.0001' };
    fs.writeFileSync(path.join(cfgDir, 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2));

    const mock = await startMockAnthropic();
    mock.queue.push({
      json: {
        id: 'msg_1', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'all done [[TASK_DONE]]' }],
        stop_reason: 'end_turn',
      },
    });

    // Counting fake Slack client. A caller-provided sender must be reused
    // for every post and left running (the caller owns its lifecycle) —
    // run() must neither start nor stop it, and must NOT construct a fresh
    // client per post (the pre-E3 behaviour).
    let sendCalls = 0, deleteCalls = 0, stopCalls = 0, startCalls = 0;
    const fakeSender = {
      async start() { startCalls++; },
      async send() { sendCalls++; return { ts: `${sendCalls}.0` }; },
      async deleteMessage() { deleteCalls++; },
      async stop() { stopCalls++; },
    };

    const { runTaskTurn } = await loadRouter();
    const r = await runTaskTurn({
      task,
      team: makeTeam('shop', ['planner', 'backend'], 'planner'),
      agentsById: {
        planner: makeAgent('planner', 'You are the planner.'),
        backend: makeAgent('backend', 'You are the backend.'),
      },
      userMessage: 'go',
      configDir: cfgDir,
      apiKey: 'sk-test',
      baseUrl: mock.baseUrl,
      slackSender: fakeSender,
    });

    expect(r.stoppedBy).toBe('done');
    // user echo + typing placeholder + reply + done marker — all four posts
    // go through the single provided sender.
    expect(sendCalls).toBeGreaterThanOrEqual(4);
    // the typing placeholder was cleared through the same sender.
    expect(deleteCalls).toBeGreaterThanOrEqual(1);
    // caller-owned sender: run() neither starts nor stops it.
    expect(startCalls).toBe(0);
    expect(stopCalls).toBe(0);
    await mock.close();
  });

  test('lead → @backend → lead handoff records all three turns and closes via the lead', async () => {
    const cfgDir = tmpDir('p13-handoff');
    fs.mkdirSync(path.join(cfgDir, 'tasks'), { recursive: true });
    const task = { ...makeTask('shop', 'planner'), id: 't_20260518_rout02' };
    fs.writeFileSync(path.join(cfgDir, 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2));

    const mock = await startMockAnthropic();
    // Turn 1: planner mentions backend.
    mock.queue.push({
      json: {
        id: 'm1', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'Need code from @backend please.' }],
        stop_reason: 'end_turn',
      },
    });
    // Turn 2: backend replies without a mention.
    mock.queue.push({
      json: {
        id: 'm2', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'Implemented.' }],
        stop_reason: 'end_turn',
      },
    });
    // Turn 3: planner closes.
    mock.queue.push({
      json: {
        id: 'm3', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'Looks good. [[TASK_DONE]]' }],
        stop_reason: 'end_turn',
      },
    });

    const { runTaskTurn } = await loadRouter();
    const r = await runTaskTurn({
      task,
      team: makeTeam('shop', ['planner', 'backend', 'frontend'], 'planner'),
      agentsById: {
        planner: makeAgent('planner', 'You are the planner.'),
        backend: makeAgent('backend', 'You are the backend.'),
        frontend: makeAgent('frontend', 'You are the frontend.'),
      },
      userMessage: 'ship feature X',
      configDir: cfgDir,
      apiKey: 'sk-test',
      baseUrl: mock.baseUrl,
    });
    expect(r.stoppedBy).toBe('done');
    expect(r.iterations).toBe(3);
    expect(r.task.status).toBe('done');
    const speakers = r.task.turns.map((t) => t.agent);
    expect(speakers).toEqual(['user', 'planner', 'backend', 'planner']);
    await mock.close();
  });

  test('budget exhaustion returns stoppedBy=budget and pauses the task (not done)', async () => {
    const cfgDir = tmpDir('p13-budget');
    fs.mkdirSync(path.join(cfgDir, 'tasks'), { recursive: true });
    const task = { ...makeTask('shop', 'planner'), id: 't_20260518_rout03' };
    fs.writeFileSync(path.join(cfgDir, 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2));

    const mock = await startMockAnthropic();
    // Every reply mentions backend; backend's replies mention planner.
    // Either way the queue never drains.
    for (let i = 0; i < 10; i++) {
      mock.queue.push({
        json: {
          id: `m${i}`, type: 'message', role: 'assistant',
          content: [{ type: 'text', text: i % 2 === 0 ? '@backend keep going' : '@planner more' }],
          stop_reason: 'end_turn',
        },
      });
    }

    const { runTaskTurn } = await loadRouter();
    const r = await runTaskTurn({
      task,
      team: makeTeam('shop', ['planner', 'backend'], 'planner'),
      agentsById: {
        planner: makeAgent('planner', 'P'),
        backend: makeAgent('backend', 'B'),
      },
      userMessage: 'spin',
      configDir: cfgDir,
      apiKey: 'sk-test',
      baseUrl: mock.baseUrl,
      maxAgentTurns: 3,
    });
    expect(r.stoppedBy).toBe('budget');
    expect(r.iterations).toBe(3);
    // Budget exhaustion is a pause, not done/failed → 'paused' (resumable).
    expect(r.task.status).toBe('paused');
    await mock.close();
  });

  test('a non-lead speaker without mentions returns control to the lead', async () => {
    const cfgDir = tmpDir('p13-handback');
    fs.mkdirSync(path.join(cfgDir, 'tasks'), { recursive: true });
    const task = { ...makeTask('shop', 'planner'), id: 't_20260518_rout04' };
    fs.writeFileSync(path.join(cfgDir, 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2));

    const mock = await startMockAnthropic();
    // planner mentions backend, backend goes silent (no mentions), then
    // planner closes. We only get the queue to drain because the router
    // re-queues the lead on backend's silent turn.
    mock.queue.push({ json: { id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'text', text: '@backend please' }], stop_reason: 'end_turn' } });
    mock.queue.push({ json: { id: 'm2', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'done my part' }], stop_reason: 'end_turn' } });
    mock.queue.push({ json: { id: 'm3', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'wrapping up [[TASK_DONE]]' }], stop_reason: 'end_turn' } });

    const { runTaskTurn } = await loadRouter();
    const r = await runTaskTurn({
      task,
      team: makeTeam('shop', ['planner', 'backend'], 'planner'),
      agentsById: {
        planner: makeAgent('planner', 'P'),
        backend: makeAgent('backend', 'B'),
      },
      userMessage: 'go',
      configDir: cfgDir,
      apiKey: 'sk-test',
      baseUrl: mock.baseUrl,
    });
    expect(r.stoppedBy).toBe('done');
    expect(r.task.turns.map((t) => t.agent)).toEqual(['user', 'planner', 'backend', 'planner']);
    await mock.close();
  });

  test('lazyclaw task tick wires the router from the CLI', async () => {
    const mock = await startMockAnthropic();
    mock.queue.push({ json: { id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'on it [[TASK_DONE]]' }], stop_reason: 'end_turn' } });

    const cfg = tmpDir('p13-cli');
    expect(runCli(['agent', 'add', 'planner', '--provider', 'anthropic', '--model', 'claude-opus-4-7'], cfg).status).toBe(0);
    expect(runCli(['agent', 'add', 'backend', '--provider', 'anthropic', '--model', 'claude-opus-4-7'], cfg).status).toBe(0);
    expect(runCli(['team',  'add', 'shop', '--agents', 'planner,backend', '--lead', 'planner'], cfg).status).toBe(0);
    const start = runCli(['task', 'start', '--team', 'shop', '--title', 'cli tick'], cfg);
    expect(start.status).toBe(0);
    const task = JSON.parse(start.stdout);

    // Seed an api key profile so _resolveAuthKey returns 'sk-test'.
    expect(runCli(['auth', 'add', 'anthropic', 'sk-test', '--label', 'mock'], cfg).status).toBe(0);
    expect(runCli(['auth', 'use',  'anthropic', 'mock'], cfg).status).toBe(0);

    const r = await runCliAsync(['task', 'tick', task.id, 'do the thing', '--max-turns', '3'], cfg, {
      LAZYCLAW_ANTHROPIC_BASE_URL: mock.baseUrl,
    });
    expect(r.status).toBe(0);
    const summary = JSON.parse(r.stdout);
    expect(summary.stoppedBy).toBe('done');
    const onDisk = JSON.parse(fs.readFileSync(path.join(cfg, 'tasks', `${task.id}.json`), 'utf8'));
    expect(onDisk.status).toBe('done');
    expect(onDisk.turns.length).toBeGreaterThanOrEqual(2);
    await mock.close();
  });
});
