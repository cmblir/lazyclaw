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

// Mock Anthropic Messages API. Caller queues a sequence of canned
// responses; each POST /messages pops the next one. Bodies are also
// captured so the test can assert what we sent (tools[], messages[]).
interface Response {
  status?: number;
  json: Record<string, unknown>;
}
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
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'mock anthropic: queue empty' }));
          return;
        }
        res.writeHead(next.status || 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(next.json));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
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
  return await import(url) as typeof import('../mas/agent_turn.mjs');
}

const fullAgent = {
  name: 'planner',
  displayName: 'Planner',
  role: 'You are a careful planner.',
  provider: 'anthropic',
  model: 'claude-opus-4-7',
  tools: ['bash', 'read', 'write', 'grep'],
};

test.describe('Phase 12b — Anthropic tool-use adapter', () => {
  test('one-shot final response (no tool calls) returns text verbatim', async () => {
    const mock = await startMockAnthropic();
    mock.queue.push({
      json: {
        id: 'msg_1', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'just a chat response' }],
        stop_reason: 'end_turn',
      },
    });

    const { runAgentTurn } = await loadRunner();
    const r = await runAgentTurn({
      agent: fullAgent,
      userMessage: 'hello',
      apiKey: 'sk-test',
      baseUrl: `${mock.baseUrl}/v1`,
    });
    expect(r.stoppedBy).toBe('final');
    expect(r.text).toBe('just a chat response');
    expect(r.iterations).toBe(1);
    expect(r.toolCalls).toEqual([]);

    // What we sent: system prompt + 1 user message + tools array.
    const sent = mock.posts[0].body as { system: string; messages: Array<{role: string, content: string}>; tools: Array<{name: string}> };
    expect(sent.system).toBe('You are a careful planner.');
    expect(sent.messages).toHaveLength(1);
    expect(sent.messages[0]).toEqual({ role: 'user', content: 'hello' });
    expect(sent.tools.map((t) => t.name).sort()).toEqual(['bash', 'grep', 'read', 'write']);

    await mock.close();
  });

  test('tool_use → tool_result → final loop drives bash and folds output back into the reply', async () => {
    const ws = tmpDir('p12b-tu');
    fs.writeFileSync(path.join(ws, 'a.txt'), 'A');
    fs.writeFileSync(path.join(ws, 'b.txt'), 'B');
    const mock = await startMockAnthropic();

    // Turn 1: assistant asks for `ls`.
    mock.queue.push({
      json: {
        id: 'msg_1', type: 'message', role: 'assistant',
        content: [
          { type: 'text', text: 'Let me list.' },
          { type: 'tool_use', id: 'toolu_01', name: 'bash', input: { command: 'ls' } },
        ],
        stop_reason: 'tool_use',
      },
    });
    // Turn 2: assistant wraps up.
    mock.queue.push({
      json: {
        id: 'msg_2', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'Done. Two files: a.txt, b.txt.' }],
        stop_reason: 'end_turn',
      },
    });

    const { runAgentTurn } = await loadRunner();
    const r = await runAgentTurn({
      agent: fullAgent,
      userMessage: 'list files',
      apiKey: 'sk-test',
      baseUrl: `${mock.baseUrl}/v1`,
      cwd: ws,
    });
    expect(r.stoppedBy).toBe('final');
    expect(r.iterations).toBe(2);
    expect(r.text).toMatch(/Two files/);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]).toMatchObject({ name: 'bash', ok: true });
    expect(r.toolCalls[0].result.stdout).toContain('a.txt');

    // 2nd request must include the assistant turn AND a user-role
    // tool_result block correlating by the original tool_use id.
    const sent2 = mock.posts[1].body as { messages: Array<Record<string, unknown>> };
    expect(sent2.messages).toHaveLength(3);
    const tr = sent2.messages[2] as { role: string, content: Array<{type: string, tool_use_id: string}> };
    expect(tr.role).toBe('user');
    expect(tr.content[0].type).toBe('tool_result');
    expect(tr.content[0].tool_use_id).toBe('toolu_01');

    await mock.close();
  });

  test('a denied tool comes back as a tool_result with is_error=true so the model can recover', async () => {
    const mock = await startMockAnthropic();
    mock.queue.push({
      json: {
        id: 'msg_1', type: 'message', role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_02', name: 'bash', input: { command: 'rm -rf /' } }],
        stop_reason: 'tool_use',
      },
    });
    mock.queue.push({
      json: {
        id: 'msg_2', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'Sorry — I cannot run bash.' }],
        stop_reason: 'end_turn',
      },
    });

    const readOnly = { ...fullAgent, tools: ['read', 'grep'] };
    const { runAgentTurn } = await loadRunner();
    const r = await runAgentTurn({
      agent: readOnly,
      userMessage: 'delete everything',
      apiKey: 'sk-test',
      baseUrl: `${mock.baseUrl}/v1`,
    });
    expect(r.stoppedBy).toBe('final');
    expect(r.toolCalls[0].ok).toBe(false);
    expect(r.toolCalls[0].result.code).toBe('TOOL_DENIED');

    const sent2 = mock.posts[1].body as { messages: Array<Record<string, unknown>> };
    const tr = sent2.messages[2] as { content: Array<{is_error?: boolean}> };
    expect(tr.content[0].is_error).toBe(true);
  });

  test('iteration budget exhaustion returns stoppedBy=budget instead of looping forever', async () => {
    const mock = await startMockAnthropic();
    // Always reply with a fresh tool_use → forces infinite loop intent.
    for (let i = 0; i < 6; i++) {
      mock.queue.push({
        json: {
          id: `msg_${i}`, type: 'message', role: 'assistant',
          content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'bash', input: { command: 'echo hi' } }],
          stop_reason: 'tool_use',
        },
      });
    }

    const { runAgentTurn } = await loadRunner();
    const r = await runAgentTurn({
      agent: fullAgent,
      userMessage: 'spin',
      apiKey: 'sk-test',
      baseUrl: `${mock.baseUrl}/v1`,
      maxIterations: 3,
    });
    expect(r.stoppedBy).toBe('budget');
    expect(r.iterations).toBe(3);
    expect(r.toolCalls).toHaveLength(3);
  });

  test('agent_turn audit log captures every tool call when taskId is set', async () => {
    const cfg = tmpDir('p12b-audit-cfg');
    const ws = tmpDir('p12b-audit-ws');
    const mock = await startMockAnthropic();
    mock.queue.push({
      json: {
        id: 'msg_1', type: 'message', role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_01', name: 'write', input: { path: 'r.md', content: 'report' } }],
        stop_reason: 'tool_use',
      },
    });
    mock.queue.push({
      json: {
        id: 'msg_2', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'wrote it' }],
        stop_reason: 'end_turn',
      },
    });

    const taskId = 't_20260518_audit3';
    const { runAgentTurn } = await loadRunner();
    await runAgentTurn({
      agent: fullAgent,
      userMessage: 'write a report',
      apiKey: 'sk-test',
      baseUrl: `${mock.baseUrl}/v1`,
      taskId, configDir: cfg, cwd: ws,
    });

    const auditFile = path.join(cfg, 'tasks', `${taskId}.audit.jsonl`);
    expect(fs.existsSync(auditFile)).toBe(true);
    const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ tool: 'write', agent: 'planner', ok: true });
    expect(fs.readFileSync(path.join(ws, 'r.md'), 'utf8')).toBe('report');
    await mock.close();
  });

  test('an unsupported provider throws a clear error', async () => {
    const { runAgentTurn } = await loadRunner();
    let err: Error & { code?: string } | null = null;
    try {
      await runAgentTurn({
        // ollama (and any other chat-only provider) doesn't have a
        // tool-use adapter yet. claude-cli was added in Phase 19, so
        // we no longer assert against that name here.
        agent: { ...fullAgent, provider: 'ollama' },
        userMessage: 'x',
        apiKey: 'k',
      });
    } catch (e) { err = e as Error & { code?: string }; }
    expect(err).toBeTruthy();
    expect(err!.code).toBe('PROVIDER_UNSUPPORTED');
  });
});
