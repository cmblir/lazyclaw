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
  posts: Array<{ body: Record<string, unknown> }>;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const queue: Response[] = [];
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

interface Daemon {
  port: number;
  baseUrl: string;
  child: ChildProcessWithoutNullStreams;
  stop: () => Promise<void>;
}
async function startDaemon(cfgDir: string): Promise<Daemon> {
  const child = spawn(process.execPath, [CLI, 'daemon', '--port', '0'], {
    env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let port = 0; let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    const nl = buf.indexOf('\n');
    if (nl >= 0 && !port) { try { const j = JSON.parse(buf.slice(0, nl)); if (j.port) port = j.port; } catch { /* skip */ } }
  });
  const start = Date.now();
  while (!port && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 50));
  if (!port) { child.kill('SIGKILL'); throw new Error('daemon never bound'); }
  return {
    port, baseUrl: `http://127.0.0.1:${port}`, child,
    stop: () => new Promise<void>((r) => {
      child.on('close', () => r());
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } r(); }, 3000);
    }),
  };
}

async function loadMem() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'mas', 'agent_memory.mjs')).href;
  return await import(url) as typeof import('../mas/agent_memory.mjs');
}

function anthropicTextReply(id: string, text: string): Response {
  return { json: { id, type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } };
}

test.describe('Phase 18 — agent memory', () => {
  test('registerAgent stores memoryWrite default "auto" and a 12 KB cap', async () => {
    const cfg = tmpDir('p18-defaults');
    const r = runCli(['agent', 'add', 'planner'], cfg);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.memoryWrite).toBe('auto');
    expect(out.memoryMaxChars).toBe(12 * 1024);
  });

  test('readMemory returns "" for a missing file and the raw contents otherwise', async () => {
    const cfg = tmpDir('p18-read');
    const mod = await loadMem();
    expect(mod.readMemory('planner', cfg)).toBe('');

    mod.writeRaw('planner', '# planner — memory\n\n## 2026-05-19 — t_test\n- hi\n', cfg);
    const text = mod.readMemory('planner', cfg);
    expect(text).toContain('## 2026-05-19');
  });

  test('readMemory truncates from the top and appends a marker', async () => {
    const cfg = tmpDir('p18-trunc');
    const mod = await loadMem();
    // Build a 40 KB body with paragraph breaks so the boundary-aware
    // cutter has something to land on.
    const para = '## entry\n' + 'x'.repeat(2048) + '\n\n';
    const big = '# planner — memory\n\n' + para.repeat(20);
    mod.writeRaw('planner', big, cfg);

    const cut = mod.readMemory('planner', cfg, 8 * 1024);
    expect(cut.length).toBeLessThanOrEqual(8 * 1024 + 100);  // +slack for marker
    expect(cut).toContain('older entries truncated');
  });

  test('prependEntry pushes the newest reflection above older ones, preserving the title', async () => {
    const cfg = tmpDir('p18-prepend');
    const mod = await loadMem();
    mod.prependEntry('planner', { taskId: 't_1', title: 'first', body: '- first lesson' }, cfg);
    mod.prependEntry('planner', { taskId: 't_2', title: 'second', body: '- second lesson' }, cfg);

    const text = fs.readFileSync(mod.memoryPath('planner', cfg), 'utf8');
    expect(text.startsWith('# planner — memory\n')).toBe(true);
    const idxSecond = text.indexOf('t_2');
    const idxFirst = text.indexOf('t_1');
    expect(idxSecond).toBeGreaterThan(-1);
    expect(idxFirst).toBeGreaterThan(idxSecond);  // newest (t_2) above oldest (t_1)
  });

  test('buildMemoryBlock returns empty for a fresh agent and a wrapped block once data is present', async () => {
    const cfg = tmpDir('p18-block');
    const mod = await loadMem();
    expect(mod.buildMemoryBlock('planner', cfg)).toBe('');
    mod.prependEntry('planner', { taskId: 't_1', title: 't', body: '- one' }, cfg);
    const block = mod.buildMemoryBlock('planner', cfg);
    expect(block).toContain('What you remember from prior tasks');
    expect(block).toContain('- one');
  });

  test('mention router injects the memory block into the system prompt', async () => {
    const mock = await startMockAnthropic();
    mock.queue.push({
      json: { id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'on it [[TASK_DONE]]' }], stop_reason: 'end_turn' },
    });
    // Mock the reflection call too (auto fires after done).
    mock.queue.push({
      json: { id: 'm2', type: 'message', role: 'assistant', content: [{ type: 'text', text: '- learned X\n- learned Y' }], stop_reason: 'end_turn' },
    });

    const cfg = tmpDir('p18-router');
    expect(runCli(['agent', 'add', 'planner', '--provider', 'anthropic'], cfg).status).toBe(0);
    expect(runCli(['team', 'add', 'shop', '--agents', 'planner'], cfg).status).toBe(0);
    expect(runCli(['auth', 'add', 'anthropic', 'sk-test', '--label', 'm'], cfg).status).toBe(0);
    expect(runCli(['auth', 'use', 'anthropic', 'm'], cfg).status).toBe(0);

    // Seed prior memory so the system prompt has something to carry.
    const mod = await loadMem();
    mod.prependEntry('planner', { taskId: 't_prior', title: 'prior task', body: '- prior insight A' }, cfg);

    const open = JSON.parse(runCli(['task', 'start', '--team', 'shop', '--title', 'now'], cfg).stdout);
    const tick = await runCliAsync(['task', 'tick', open.id, 'go'], cfg, { LAZYCLAW_ANTHROPIC_BASE_URL: mock.baseUrl });
    expect(tick.status).toBe(0);
    expect(JSON.parse(tick.stdout).stoppedBy).toBe('done');

    // First request to anthropic must include the prior-insight bullet
    // inside the system prompt body.
    const firstPost = mock.posts[0].body as { system: string };
    expect(firstPost.system).toContain('prior insight A');
    expect(firstPost.system).toContain('What you remember');
    await mock.close();
  });

  test('auto reflection on done prepends a new memory entry; manual mode skips the auto write', async () => {
    const mock = await startMockAnthropic();
    // Turn 1: lead says DONE.
    mock.queue.push({
      json: { id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'wrapping [[TASK_DONE]]' }], stop_reason: 'end_turn' },
    });
    // Turn 2: reflection response.
    mock.queue.push({
      json: { id: 'm2', type: 'message', role: 'assistant', content: [{ type: 'text', text: '- watch out for X\n- prefer Y' }], stop_reason: 'end_turn' },
    });

    const cfg = tmpDir('p18-auto');
    expect(runCli(['agent', 'add', 'planner', '--provider', 'anthropic'], cfg).status).toBe(0);
    expect(runCli(['team', 'add', 'shop', '--agents', 'planner'], cfg).status).toBe(0);
    expect(runCli(['auth', 'add', 'anthropic', 'sk-test', '--label', 'm'], cfg).status).toBe(0);
    expect(runCli(['auth', 'use', 'anthropic', 'm'], cfg).status).toBe(0);
    const open = JSON.parse(runCli(['task', 'start', '--team', 'shop', '--title', 'wrap'], cfg).stdout);
    const tick = await runCliAsync(['task', 'tick', open.id, 'go'], cfg, { LAZYCLAW_ANTHROPIC_BASE_URL: mock.baseUrl });
    expect(tick.status).toBe(0);

    const mod = await loadMem();
    const mem = mod.readMemory('planner', cfg);
    expect(mem).toContain('watch out for X');
    expect(mem).toContain(`task ${open.id}`);
    await mock.close();

    // Now flip the agent to memoryWrite=off and run a fresh task; the
    // memory file should NOT pick up a second entry.
    const mock2 = await startMockAnthropic();
    mock2.queue.push({
      json: { id: 'm3', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'one more [[TASK_DONE]]' }], stop_reason: 'end_turn' },
    });
    // Patch via the daemon-style path — the easiest way without a
    // dedicated CLI flag is to write the agent file directly.
    const agentFile = path.join(cfg, 'agents', 'planner.json');
    const agentRec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    agentRec.memoryWrite = 'off';
    fs.writeFileSync(agentFile, JSON.stringify(agentRec, null, 2));

    const open2 = JSON.parse(runCli(['task', 'start', '--team', 'shop', '--title', 'no-write'], cfg).stdout);
    const tick2 = await runCliAsync(['task', 'tick', open2.id, 'go'], cfg, { LAZYCLAW_ANTHROPIC_BASE_URL: mock2.baseUrl });
    expect(tick2.status).toBe(0);

    const memAfter = mod.readMemory('planner', cfg);
    // Only the first task's reflection should be present; no entry
    // for task `open2.id`.
    expect(memAfter).not.toContain(`task ${open2.id}`);
    await mock2.close();
  });

  test('lazyclaw agent memory show / clear works against the on-disk file', async () => {
    const cfg = tmpDir('p18-cli-memory');
    const mod = await loadMem();
    mod.prependEntry('planner', { taskId: 't_x', title: 'x', body: '- a\n- b' }, cfg);

    const show = runCli(['agent', 'memory', 'show', 'planner'], cfg);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain('- a');

    const clr = runCli(['agent', 'memory', 'clear', 'planner'], cfg);
    expect(clr.status).toBe(0);
    expect(clr.stdout).toMatch(/cleared memory/);

    const show2 = runCli(['agent', 'memory', 'show', 'planner'], cfg);
    expect(show2.status).toBe(0);
    expect(show2.stderr).toMatch(/no memory/);
  });

  test('lazyclaw agent reflect runs an LLM call and prepends the result', async () => {
    const mock = await startMockAnthropic();
    mock.queue.push({
      json: { id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'text', text: '- explicit lesson\n- another' }], stop_reason: 'end_turn' },
    });

    const cfg = tmpDir('p18-cli-reflect');
    expect(runCli(['agent', 'add', 'planner', '--provider', 'anthropic'], cfg).status).toBe(0);
    expect(runCli(['team', 'add', 'shop', '--agents', 'planner'], cfg).status).toBe(0);
    expect(runCli(['auth', 'add', 'anthropic', 'sk-test', '--label', 'm'], cfg).status).toBe(0);
    expect(runCli(['auth', 'use', 'anthropic', 'm'], cfg).status).toBe(0);
    const open = JSON.parse(runCli(['task', 'start', '--team', 'shop', '--title', 'manual'], cfg).stdout);

    const r = await runCliAsync(['agent', 'reflect', 'planner', '--task', open.id], cfg, { LAZYCLAW_ANTHROPIC_BASE_URL: mock.baseUrl });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('explicit lesson');

    const mod = await loadMem();
    expect(mod.readMemory('planner', cfg)).toContain('explicit lesson');
    await mock.close();
  });

  // Finding #2 — reflectOnce must redact secrets both on the way OUT (the prompt
  // sent to the LLM) and on the way BACK (the body the caller persists into
  // every future system prompt). A token pasted into a transcript must never
  // reach the model nor land on disk.
  test('reflectOnce redacts a sk- token from both the outgoing prompt and the returned body', async () => {
    const mock = await startMockAnthropic();
    // The model echoes the secret back in its reflection bullets.
    mock.queue.push(anthropicTextReply('m1', '- remember the key sk-live1234567890abcdef\n- another lesson'));
    const mod = await loadMem();

    const agent = { name: 'planner', provider: 'anthropic', model: 'm', role: 'r' };
    const task = { id: 't_sec', title: 'leaky', turns: [{ agent: 'user', text: 'my key is sk-live1234567890abcdef keep it' }] };
    const body = await mod.reflectOnce({ agent, task, apiKey: 'sk-test', baseUrl: mock.baseUrl });

    // Outgoing prompt to the model must not carry the transcript secret verbatim.
    const sent = JSON.stringify(mock.posts[0].body);
    expect(sent).not.toContain('sk-live1234567890abcdef');
    // Returned body (which the router persists) must not carry the echoed secret.
    expect(body).not.toContain('sk-live1234567890abcdef');
    expect(body).toContain('[REDACTED]');
    await mock.close();
  });

  // Finding #2 (end-to-end) — the persisted memory file must not contain the
  // secret either, since prependEntry writes the reflectOnce body to disk.
  test('a sk- token never lands in the stored memory file', async () => {
    const mock = await startMockAnthropic();
    mock.queue.push(anthropicTextReply('m1', '- the secret was sk-live1234567890abcdef'));
    const mod = await loadMem();
    const cfg = tmpDir('p18-redact-store');

    const agent = { name: 'planner', provider: 'anthropic', model: 'm', role: 'r' };
    const task = { id: 't_store', title: 'leak', turns: [{ agent: 'user', text: 'use sk-live1234567890abcdef' }] };
    const body = await mod.reflectOnce({ agent, task, apiKey: 'sk-test', baseUrl: mock.baseUrl });
    mod.prependEntry('planner', { taskId: task.id, title: task.title, body }, cfg);

    const stored = fs.readFileSync(mod.memoryPath('planner', cfg), 'utf8');
    expect(stored).not.toContain('sk-live1234567890abcdef');
    expect(stored).toContain('[REDACTED]');
    await mock.close();
  });

  // Finding #4 — truncation must not leave a lone high-surrogate. We build a
  // body whose byte/char budget lands the cut exactly on a surrogate pair so a
  // naive slice would orphan the leading half.
  test('readMemory truncation never leaves a lone high-surrogate', async () => {
    const cfg = tmpDir('p18-surrogate');
    const mod = await loadMem();
    // Filler with no paragraph break near the cut, then an emoji (a surrogate
    // pair) positioned so the slice boundary splits it.
    const filler = 'a'.repeat(99);          // 99 chars, no '\n\n'
    const emoji = '\u{1F600}';              // 😀 = two UTF-16 code units
    const raw = filler + emoji + 'tail';    // boundary at maxChars=100 splits the pair
    mod.writeRaw('planner', raw, cfg);

    const cut = mod.readMemory('planner', cfg, 100);
    // No unpaired high-surrogate (\uD800-\uDBFF) may survive at the cut.
    const lastReal = cut.replace(/\n\n…\[older entries truncated\]\n$/, '');
    expect(/[\uD800-\uDBFF]$/.test(lastReal)).toBe(false);
    // The lone high-surrogate is dropped, not preserved as a broken char.
    expect(lastReal.endsWith(filler)).toBe(true);
  });

  test('daemon GET/PUT/DELETE /agents/<name>/memory round-trips a markdown body', async () => {
    const cfg = tmpDir('p18-daemon-mem');
    expect(runCli(['agent', 'add', 'planner'], cfg).status).toBe(0);
    const d = await startDaemon(cfg);
    try {
      const get1 = await fetch(`${d.baseUrl}/agents/planner/memory`);
      expect(get1.ok).toBe(true);
      expect(await get1.text()).toBe('');

      const put = await fetch(`${d.baseUrl}/agents/planner/memory`, {
        method: 'PUT',
        headers: { 'content-type': 'text/markdown' },
        body: '# planner — memory\n\n## 2026-05-19 — manual\n- entry from dashboard\n',
      });
      expect(put.ok).toBe(true);

      const get2 = await fetch(`${d.baseUrl}/agents/planner/memory`);
      const text = await get2.text();
      expect(text).toContain('entry from dashboard');

      const del = await fetch(`${d.baseUrl}/agents/planner/memory`, { method: 'DELETE' });
      expect(del.ok).toBe(true);

      const get3 = await fetch(`${d.baseUrl}/agents/planner/memory`);
      expect(await get3.text()).toBe('');
    } finally { await d.stop(); }
  });
});
