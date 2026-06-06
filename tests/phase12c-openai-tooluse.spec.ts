import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lc-${prefix}-`));
}

interface Response { status?: number; json: Record<string, unknown>; }
function startMockOpenAI(): Promise<{
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

async function loadRunner() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'mas', 'agent_turn.mjs')).href;
  const mod = await import(url) as typeof import('../mas/agent_turn.mjs');
  // Sensitive tools (bash/write) are fail-closed; these adapter round-trip
  // tests exercise tool execution, not the approval gate — auto-approve unless
  // a test passes its own approve hook.
  return {
    ...mod,
    runAgentTurn: ((opts) => mod.runAgentTurn({ approve: async () => ({ approved: true }), ...opts })) as typeof mod.runAgentTurn,
  };
}

const openaiAgent = {
  name: 'planner',
  displayName: 'Planner',
  role: 'You are a careful planner.',
  provider: 'openai',
  model: 'gpt-4.1',
  tools: ['bash', 'read', 'write', 'grep'],
};

test.describe('Phase 12c — OpenAI tool-use adapter', () => {
  test('one-shot final response (no tool_calls) returns content verbatim', async () => {
    const mock = await startMockOpenAI();
    mock.queue.push({
      json: {
        choices: [{
          message: { role: 'assistant', content: 'a plain answer' },
          finish_reason: 'stop',
        }],
      },
    });

    const { runAgentTurn } = await loadRunner();
    const r = await runAgentTurn({
      agent: openaiAgent,
      userMessage: 'hi',
      apiKey: 'sk-test',
      baseUrl: mock.baseUrl,
    });
    expect(r.stoppedBy).toBe('final');
    expect(r.text).toBe('a plain answer');
    expect(r.iterations).toBe(1);

    // OpenAI carries the system prompt as messages[0] (role:system).
    const sent = mock.posts[0].body as { messages: Array<{role: string, content: string}>; tools: Array<{type: string, function: {name: string}}> };
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'You are a careful planner.' });
    expect(sent.messages[1]).toEqual({ role: 'user', content: 'hi' });
    expect(sent.tools[0].type).toBe('function');
    expect(sent.tools.map((t) => t.function.name).sort()).toEqual(['bash', 'grep', 'read', 'write']);
    await mock.close();
  });

  test('tool_calls (JSON-string arguments) parse and round-trip through the tool runner', async () => {
    const ws = tmpDir('p12c-tc');
    fs.writeFileSync(path.join(ws, 'a.txt'), 'A');
    const mock = await startMockOpenAI();

    mock.queue.push({
      json: {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_01',
              type: 'function',
              function: { name: 'bash', arguments: JSON.stringify({ command: 'ls a.txt' }) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      },
    });
    mock.queue.push({
      json: {
        choices: [{
          message: { role: 'assistant', content: 'one file: a.txt' },
          finish_reason: 'stop',
        }],
      },
    });

    const { runAgentTurn } = await loadRunner();
    const r = await runAgentTurn({
      agent: openaiAgent,
      userMessage: 'ls',
      apiKey: 'sk-test',
      baseUrl: mock.baseUrl,
      cwd: ws,
    });
    expect(r.stoppedBy).toBe('final');
    expect(r.iterations).toBe(2);
    expect(r.text).toContain('a.txt');
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]).toMatchObject({ name: 'bash', input: { command: 'ls a.txt' }, ok: true });

    // 2nd request must echo the assistant turn AND a role=tool message
    // referencing the original tool_call_id.
    const sent2 = mock.posts[1].body as { messages: Array<{role: string, tool_call_id?: string, tool_calls?: unknown}> };
    expect(sent2.messages.find((m) => m.role === 'tool')?.tool_call_id).toBe('call_01');
    expect(sent2.messages.find((m) => m.role === 'assistant')?.tool_calls).toBeTruthy();
    await mock.close();
  });

  test('multiple tool_calls in one assistant turn each get their own role=tool message', async () => {
    const ws = tmpDir('p12c-multi');
    fs.writeFileSync(path.join(ws, 'a.txt'), 'A');
    fs.writeFileSync(path.join(ws, 'b.txt'), 'B');
    const mock = await startMockOpenAI();

    mock.queue.push({
      json: {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_aa', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'a.txt' }) } },
              { id: 'call_bb', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'b.txt' }) } },
            ],
          },
          finish_reason: 'tool_calls',
        }],
      },
    });
    mock.queue.push({
      json: {
        choices: [{
          message: { role: 'assistant', content: 'done' },
          finish_reason: 'stop',
        }],
      },
    });

    const { runAgentTurn } = await loadRunner();
    const r = await runAgentTurn({
      agent: openaiAgent,
      userMessage: 'read both',
      apiKey: 'sk-test',
      baseUrl: mock.baseUrl,
      cwd: ws,
    });
    expect(r.toolCalls).toHaveLength(2);

    const sent2 = mock.posts[1].body as { messages: Array<{role: string, tool_call_id?: string}> };
    const toolMsgs = sent2.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs.map((m) => m.tool_call_id).sort()).toEqual(['call_aa', 'call_bb']);
    await mock.close();
  });

  test('a denied tool comes back as a role=tool message the model can read and adapt to', async () => {
    const mock = await startMockOpenAI();
    mock.queue.push({
      json: {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_99',
              type: 'function',
              function: { name: 'bash', arguments: JSON.stringify({ command: 'rm -rf /' }) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      },
    });
    mock.queue.push({
      json: {
        choices: [{
          message: { role: 'assistant', content: 'I cannot run bash.' },
          finish_reason: 'stop',
        }],
      },
    });

    const readOnly = { ...openaiAgent, tools: ['read', 'grep'] };
    const { runAgentTurn } = await loadRunner();
    const r = await runAgentTurn({
      agent: readOnly,
      userMessage: 'wipe',
      apiKey: 'sk-test',
      baseUrl: mock.baseUrl,
    });
    expect(r.stoppedBy).toBe('final');
    expect(r.toolCalls[0].ok).toBe(false);
    expect(r.toolCalls[0].result.code).toBe('TOOL_DENIED');

    const sent2 = mock.posts[1].body as { messages: Array<{role: string, content: string}> };
    const toolMsg = sent2.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeTruthy();
    expect(toolMsg!.content).toMatch(/TOOL_DENIED|not allowed/);
    await mock.close();
  });

  test('audit log captures each tool call from an OpenAI agent', async () => {
    const cfg = tmpDir('p12c-audit-cfg');
    const ws = tmpDir('p12c-audit-ws');
    const mock = await startMockOpenAI();
    mock.queue.push({
      json: {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_w',
              type: 'function',
              function: { name: 'write', arguments: JSON.stringify({ path: 'out.txt', content: 'hi' }) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      },
    });
    mock.queue.push({
      json: { choices: [{ message: { role: 'assistant', content: 'wrote' }, finish_reason: 'stop' }] },
    });

    const taskId = 't_20260518_audit4';
    const { runAgentTurn } = await loadRunner();
    await runAgentTurn({
      agent: openaiAgent,
      userMessage: 'write',
      apiKey: 'sk-test',
      baseUrl: mock.baseUrl,
      taskId, configDir: cfg, cwd: ws,
    });

    const auditFile = path.join(cfg, 'tasks', `${taskId}.audit.jsonl`);
    expect(fs.existsSync(auditFile)).toBe(true);
    expect(fs.readFileSync(path.join(ws, 'out.txt'), 'utf8')).toBe('hi');
    await mock.close();
  });
});
