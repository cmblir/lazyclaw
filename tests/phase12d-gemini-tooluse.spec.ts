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
function startMockGemini(): Promise<{
  baseUrl: string;
  queue: Response[];
  posts: Array<{ path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }>;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const queue: Response[] = [];
    const posts: Array<{ path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c.toString(); });
      req.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* leave empty */ }
        posts.push({ path: req.url || '', headers: req.headers, body: parsed });
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
        baseUrl: `http://127.0.0.1:${port}/v1beta`,
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

const geminiAgent = {
  name: 'planner',
  displayName: 'Planner',
  role: 'You are a careful planner.',
  provider: 'gemini',
  model: 'gemini-2.5-flash',
  tools: ['bash', 'read', 'write', 'grep'],
};

test.describe('Phase 12d — Gemini tool-use adapter', () => {
  test('one-shot final response (text-only) returns the candidate text', async () => {
    const mock = await startMockGemini();
    mock.queue.push({
      json: {
        candidates: [{
          content: { role: 'model', parts: [{ text: 'short answer' }] },
          finishReason: 'STOP',
        }],
      },
    });

    const { runAgentTurn } = await loadRunner();
    const r = await runAgentTurn({
      agent: geminiAgent,
      userMessage: 'ping',
      apiKey: 'AI-test',
      baseUrl: mock.baseUrl,
    });
    expect(r.stoppedBy).toBe('final');
    expect(r.text).toBe('short answer');
    expect(r.iterations).toBe(1);

    // The model is in the URL, not the body.
    expect(mock.posts[0].path).toContain('/models/gemini-2.5-flash:generateContent');
    const sent = mock.posts[0].body as { contents: Array<{role: string, parts: Array<{text: string}>}>; system_instruction: {parts: Array<{text: string}>}; tools: Array<{function_declarations: Array<{name: string}>}> };
    expect(sent.system_instruction.parts[0].text).toBe('You are a careful planner.');
    expect(sent.contents).toHaveLength(1);
    expect(sent.contents[0]).toEqual({ role: 'user', parts: [{ text: 'ping' }] });
    // Tools are declared as ONE entry whose function_declarations holds
    // all four built-ins.
    expect(sent.tools).toHaveLength(1);
    const decls = sent.tools[0].function_declarations.map((d) => d.name).sort();
    expect(decls).toEqual(['bash', 'grep', 'read', 'write']);
    await mock.close();
  });

  test('functionCall → functionResponse → final round-trips a bash invocation', async () => {
    const ws = tmpDir('p12d-fc');
    fs.writeFileSync(path.join(ws, 'a.txt'), 'A');
    const mock = await startMockGemini();

    mock.queue.push({
      json: {
        candidates: [{
          content: {
            role: 'model',
            parts: [
              { text: 'let me list' },
              { functionCall: { name: 'bash', args: { command: 'ls a.txt' } } },
            ],
          },
          finishReason: 'STOP',
        }],
      },
    });
    mock.queue.push({
      json: {
        candidates: [{
          content: { role: 'model', parts: [{ text: 'found a.txt' }] },
          finishReason: 'STOP',
        }],
      },
    });

    const { runAgentTurn } = await loadRunner();
    const r = await runAgentTurn({
      agent: geminiAgent,
      userMessage: 'list a.txt',
      apiKey: 'AI-test',
      baseUrl: mock.baseUrl,
      cwd: ws,
    });
    expect(r.stoppedBy).toBe('final');
    expect(r.iterations).toBe(2);
    expect(r.text).toMatch(/a\.txt/);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]).toMatchObject({ name: 'bash', ok: true });

    // 2nd request must echo the model turn AND carry a user-role
    // functionResponse part keyed by `name`.
    const sent2 = mock.posts[1].body as { contents: Array<{role: string, parts: Array<Record<string, unknown>>}> };
    expect(sent2.contents).toHaveLength(3);
    const fr = sent2.contents[2];
    expect(fr.role).toBe('user');
    expect(fr.parts[0]).toHaveProperty('functionResponse');
    const frBody = fr.parts[0] as { functionResponse: { name: string; response: Record<string, unknown> } };
    expect(frBody.functionResponse.name).toBe('bash');
    await mock.close();
  });

  test('Gemini schema sanitiser strips additionalProperties before sending', async () => {
    const mock = await startMockGemini();
    mock.queue.push({
      json: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      },
    });

    const { runAgentTurn } = await loadRunner();
    await runAgentTurn({
      agent: geminiAgent,
      userMessage: 'ping',
      apiKey: 'AI-test',
      baseUrl: mock.baseUrl,
    });
    const sent = mock.posts[0].body as { tools: Array<{function_declarations: Array<{parameters: Record<string, unknown>}>}> };
    for (const d of sent.tools[0].function_declarations) {
      expect(JSON.stringify(d.parameters)).not.toMatch(/additionalProperties/);
    }
    await mock.close();
  });

  test('a denied tool surfaces an is_error=true functionResponse the model can react to', async () => {
    const mock = await startMockGemini();
    mock.queue.push({
      json: {
        candidates: [{
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'bash', args: { command: 'rm -rf /' } } }],
          },
          finishReason: 'STOP',
        }],
      },
    });
    mock.queue.push({
      json: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'I cannot.' }] }, finishReason: 'STOP' }],
      },
    });

    const readOnly = { ...geminiAgent, tools: ['read', 'grep'] };
    const { runAgentTurn } = await loadRunner();
    const r = await runAgentTurn({
      agent: readOnly,
      userMessage: 'wipe',
      apiKey: 'AI-test',
      baseUrl: mock.baseUrl,
    });
    expect(r.stoppedBy).toBe('final');
    expect(r.toolCalls[0].ok).toBe(false);

    const sent2 = mock.posts[1].body as { contents: Array<{role: string, parts: Array<{functionResponse?: { response: { is_error?: boolean } }}>}> };
    const fr = sent2.contents[2].parts[0].functionResponse!;
    expect(fr.response.is_error).toBe(true);
  });

  test('audit log captures Gemini tool calls', async () => {
    const cfg = tmpDir('p12d-audit-cfg');
    const ws = tmpDir('p12d-audit-ws');
    const mock = await startMockGemini();
    mock.queue.push({
      json: {
        candidates: [{
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'write', args: { path: 'r.md', content: 'g' } } }],
          },
          finishReason: 'STOP',
        }],
      },
    });
    mock.queue.push({
      json: { candidates: [{ content: { role: 'model', parts: [{ text: 'wrote' }] }, finishReason: 'STOP' }] },
    });

    const taskId = 't_20260518_audit5';
    const { runAgentTurn } = await loadRunner();
    await runAgentTurn({
      agent: geminiAgent,
      userMessage: 'write a report',
      apiKey: 'AI-test',
      baseUrl: mock.baseUrl,
      taskId, configDir: cfg, cwd: ws,
    });

    const auditFile = path.join(cfg, 'tasks', `${taskId}.audit.jsonl`);
    expect(fs.existsSync(auditFile)).toBe(true);
    expect(fs.readFileSync(path.join(ws, 'r.md'), 'utf8')).toBe('g');
    await mock.close();
  });
});
