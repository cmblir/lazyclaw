// FIX C3-task-stranded-running — a multi-agent task that stops on budget
// (or any non-DONE terminal exit) must NOT be stranded in status 'running'
// forever, and a human watching the thread must see what happened.
//
// Pre-fix: only the [[TASK_DONE]] marker flips task.status and posts to the
// thread. Budget exhaustion returns stoppedBy='budget' to the caller but
// leaves task.status === 'running' and posts nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lc-${prefix}-`));
}

// Minimal mock Anthropic endpoint — replicates the stub wiring shape from
// tests/phase13-mention-router.spec.ts (startMockAnthropic).
function startMockAnthropic() {
  return new Promise((resolve) => {
    const queue = [];
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
        close: () => new Promise((r) => {
          try { server.closeAllConnections(); } catch { /* node <18 */ }
          server.close(() => r());
        }),
      });
    });
  });
}

async function loadRouter() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'mas', 'mention_router.mjs')).href;
  return await import(url);
}

function makeAgent(name, role) {
  return {
    version: 1, name,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    role, provider: 'anthropic', model: 'claude-opus-4-7',
    tools: ['bash', 'read', 'write', 'grep'], tags: [],
    createdAt: '', updatedAt: '',
  };
}

function makeTeam(name, agents, lead) {
  return {
    version: 1, name, displayName: name, agents, lead,
    slackChannel: '', createdAt: '', updatedAt: '',
  };
}

function makeTask(team, lead) {
  return {
    version: 1, id: 't_20260613_strnd1',
    title: 'ship checkout flow', description: 'MVP',
    team, lead, status: 'running',
    // Live Slack thread so postToThread actually runs against our fake sender.
    slackChannel: 'C123', slackThreadTs: '1700000000.0001',
    createdAt: '', updatedAt: '', turns: [],
  };
}

test('budget exit flips task.status off running and posts a stop note', async () => {
  const cfgDir = tmpDir('f-strand-budget');
  fs.mkdirSync(path.join(cfgDir, 'tasks'), { recursive: true });
  const task = makeTask('shop', 'planner');
  fs.writeFileSync(path.join(cfgDir, 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2));

  const mock = await startMockAnthropic();
  // Lead speaks once and hands off to @backend (no [[TASK_DONE]]). With a
  // budget of 1 turn the loop exits with @backend still queued → budget.
  mock.queue.push({
    json: {
      id: 'msg_1', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: '@backend please take this' }],
      stop_reason: 'end_turn',
    },
  });

  // Counting fake Slack client; capture posted bodies so we can assert a
  // stop/budget note reaches the thread.
  const sent = [];
  const fakeSender = {
    async start() {},
    async send(_thread, body) { sent.push(String(body)); return { ts: `${sent.length}.0` }; },
    async deleteMessage() {},
    async stop() {},
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
    maxAgentTurns: 1,
    slackSender: fakeSender,
  });

  await mock.close();

  assert.equal(r.stoppedBy, 'budget', 'precondition: this run must exit via budget');
  // (a) task is no longer stranded in 'running'.
  assert.notEqual(r.task.status, 'running', 'task must not stay running after budget exit');
  // status must come from the existing vocabulary's terminal set.
  assert.ok(['done', 'failed', 'abandoned'].includes(r.task.status),
    `expected terminal status, got "${r.task.status}"`);

  // re-read from disk to confirm the patch was persisted, not just returned.
  const onDisk = JSON.parse(fs.readFileSync(path.join(cfgDir, 'tasks', `${task.id}.json`), 'utf8'));
  assert.notEqual(onDisk.status, 'running', 'persisted task must not stay running');

  // (b) a stop/budget message was posted to the thread.
  const stopNote = sent.find((b) => /budget|stopped|turn/i.test(b));
  assert.ok(stopNote, `expected a budget/stop note in thread posts; got: ${JSON.stringify(sent)}`);
});
