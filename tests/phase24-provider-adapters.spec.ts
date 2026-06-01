import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import * as http from 'node:http';
import { pathToFileURL } from 'node:url';

// Phase 24 — shared provider-adapter resolver + text-completion scaffold.
//
// Extracts the duplicated pickAdapter() switch and the no-tools
// callOnce scaffold that agent_memory.reflectOnce and
// skill_synth.synthesizeSkill used to each carry their own copy of.
//
//   resolveToolUseAdapter(provider) → dynamic-imports the matching
//     providers/tool_use/<provider>.mjs; throws on an unknown provider.
//   runTextCompletion({...})        → resolves the adapter, wraps the
//     user message (adapter.initialUserMessage when present), makes one
//     no-tools callOnce, asserts a 'final' envelope and returns its
//     text (or '').

const REPO_ROOT = process.cwd();

async function loadAdapters() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'mas', 'provider_adapters.mjs')).href;
  return await import(url) as typeof import('../mas/provider_adapters.mjs');
}

interface MockResp { status?: number; json: Record<string, unknown>; }
function startMockAnthropic(): Promise<{
  baseUrl: string;
  queue: MockResp[];
  posts: Array<{ body: Record<string, unknown> }>;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const queue: MockResp[] = [];
    const posts: Array<{ body: Record<string, unknown> }> = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c.toString(); });
      req.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* leave empty */ }
        posts.push({ body: parsed });
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
        queue, posts,
        close: () => new Promise<void>((r) => {
          try { server.closeAllConnections(); } catch { /* node <18 */ }
          server.close(() => r());
        }),
      });
    });
  });
}

test.describe('Phase 24 — provider adapters', () => {
  test('resolveToolUseAdapter maps every supported provider to its callOnce module', async () => {
    const mod = await loadAdapters();
    for (const provider of ['anthropic', 'openai', 'gemini', 'claude-cli']) {
      const adapter = await mod.resolveToolUseAdapter(provider);
      expect(typeof adapter.callOnce, `${provider}.callOnce`).toBe('function');
    }
  });

  test('resolveToolUseAdapter returns the anthropic adapter with initialUserMessage', async () => {
    const mod = await loadAdapters();
    const adapter = await mod.resolveToolUseAdapter('anthropic');
    expect(typeof adapter.initialUserMessage).toBe('function');
    const msg = adapter.initialUserMessage('hi');
    expect(msg).toEqual({ role: 'user', content: 'hi' });
  });

  test('resolveToolUseAdapter throws on an unknown provider', async () => {
    const mod = await loadAdapters();
    await expect(mod.resolveToolUseAdapter('nope')).rejects.toThrow(/nope/);
    await expect(mod.resolveToolUseAdapter(undefined)).rejects.toThrow();
  });

  test('runTextCompletion makes one no-tools call and returns the final text', async () => {
    const mock = await startMockAnthropic();
    mock.queue.push({
      json: { id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'distilled answer' }], stop_reason: 'end_turn' },
    });

    const mod = await loadAdapters();
    const text = await mod.runTextCompletion({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      system: 'you are a planner',
      userMessage: 'summarise the task',
      apiKey: 'sk-test',
      baseUrl: mock.baseUrl,
    });
    expect(text).toBe('distilled answer');

    // Exactly one request, no tools advertised, system + user wired through.
    expect(mock.posts.length).toBe(1);
    const body = mock.posts[0].body as { system?: string; tools?: unknown[]; messages: Array<{ role: string; content: string }> };
    expect(body.system).toBe('you are a planner');
    expect(body.tools === undefined || (Array.isArray(body.tools) && body.tools.length === 0)).toBe(true);
    expect(body.messages.length).toBe(1);
    expect(body.messages[0]).toEqual({ role: 'user', content: 'summarise the task' });
    await mock.close();
  });

  test('runTextCompletion returns "" when the model replies with empty text', async () => {
    const mock = await startMockAnthropic();
    mock.queue.push({
      json: { id: 'm1', type: 'message', role: 'assistant', content: [], stop_reason: 'end_turn' },
    });
    const mod = await loadAdapters();
    const text = await mod.runTextCompletion({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      userMessage: 'anything',
      apiKey: 'sk-test',
      baseUrl: mock.baseUrl,
    });
    expect(text).toBe('');
    await mock.close();
  });

  test('runTextCompletion throws when the adapter returns a non-final envelope', async () => {
    const mock = await startMockAnthropic();
    // A tool_use block makes the anthropic adapter return kind:'tool_calls'.
    mock.queue.push({
      json: {
        id: 'm1', type: 'message', role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'shell', input: { cmd: 'ls' } }],
        stop_reason: 'tool_use',
      },
    });
    const mod = await loadAdapters();
    await expect(mod.runTextCompletion({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      userMessage: 'do something',
      apiKey: 'sk-test',
      baseUrl: mock.baseUrl,
    })).rejects.toThrow(/tool_calls|final/);
    await mock.close();
  });
});
