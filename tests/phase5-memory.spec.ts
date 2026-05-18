import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';

const REPO_ROOT = process.cwd();
const CLI = path.join(REPO_ROOT, 'cli.mjs');

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lc-${prefix}-`));
}

function runCli(args: string[], cfgDir: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir, LAZYCLAW_SKIP_CRON_INSTALL: '1', ...env },
  });
}

function spawnChat(cfgDir: string, sessionId: string, env: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [CLI, 'chat', '--session', sessionId], {
    env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
}

async function waitFor(child: ChildProcessWithoutNullStreams, sink: string[], needle: string, ms = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (sink.join('').includes(needle)) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return false;
}

async function endChat(child: ChildProcessWithoutNullStreams) {
  try { child.stdin.write('/exit\n'); child.stdin.end(); } catch { /* gone */ }
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.on('close', () => resolve());
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 3000);
  });
}

test.describe('Phase 5 — memory layer', () => {
  test('fresh install: memory show core / recent return empty', () => {
    const cfg = tmpDir('p5-fresh');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);
    expect(runCli(['memory', 'show', 'core'], cfg).stdout).toBe('');
    expect(JSON.parse(runCli(['memory', 'show', 'recent'], cfg).stdout)).toEqual([]);
  });

  test('5 chat turns surface 10 entries in memory show recent (user + assistant)', async () => {
    const cfg = tmpDir('p5-recent');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);

    const child = spawnChat(cfg, 'p5-session');
    const sink: string[] = [];
    child.stdout.on('data', d => sink.push(d.toString()));
    child.stderr.on('data', d => sink.push(d.toString()));
    for (let i = 0; i < 5; i++) {
      child.stdin.write(`hi-${i}\n`);
      expect(await waitFor(child, sink, `mock-reply: hi-${i}`)).toBe(true);
    }
    await endChat(child);

    const recent = JSON.parse(runCli(['memory', 'show', 'recent'], cfg).stdout);
    // Each user turn produced an assistant reply. Memory captures both.
    expect(recent.length).toBeGreaterThanOrEqual(10);
    expect(recent.some((t: any) => t.role === 'user' && t.content === 'hi-0')).toBe(true);
    expect(recent.some((t: any) => t.role === 'assistant' && /mock-reply: hi-4/.test(t.content))).toBe(true);
  });

  test('memory dream against a synthetic 30-turn jsonl produces ≥1 episodic file and truncates recent.jsonl to ≤50 lines', () => {
    const cfg = tmpDir('p5-dream');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);

    // Seed 30 turns directly into recent.jsonl. write-through is the
    // production path, but we want a deterministic 30 without spawning
    // 30 chat exchanges.
    const memDir = path.join(cfg, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) {
      lines.push(JSON.stringify({ sessionId: 'seed', role: i % 2 === 0 ? 'user' : 'assistant', content: `turn-${i}`, ts: Date.now() + i }));
    }
    fs.writeFileSync(path.join(memDir, 'recent.jsonl'), lines.join('\n') + '\n');

    const r = runCli(['memory', 'dream'], cfg);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.topics.length).toBeGreaterThanOrEqual(1);

    // Episodic dir has at least one .md file
    const epDir = path.join(memDir, 'episodic');
    expect(fs.existsSync(epDir)).toBe(true);
    expect(fs.readdirSync(epDir).filter(f => f.endsWith('.md')).length).toBeGreaterThanOrEqual(1);

    // recent.jsonl truncated to ≤50 lines
    const after = fs.readFileSync(path.join(memDir, 'recent.jsonl'), 'utf8').split('\n').filter(Boolean);
    expect(after.length).toBeLessThanOrEqual(50);
  });

  test('goal tick with populated core.md includes core text in the assembled prompt (intercept via memory show core injection)', () => {
    const cfg = tmpDir('p5-tickmem');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);
    expect(runCli(['goal', 'add', 'ship', '--desc', 'release tomorrow'], cfg).status).toBe(0);

    // Seed core memory with a distinctive token. After `goal tick`, the
    // mock provider replies with `mock-reply: <full prompt>`, so we
    // can fish the token out of the assistant reply on the goal.
    const memDir = path.join(cfg, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'core.md'), 'CORE-TOKEN-XYZ — invariant for tick prompt verification.\n');

    const r = runCli(['goal', 'tick', 'ship', '--force'], cfg);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.reply).toContain('CORE-TOKEN-XYZ');

    const g = JSON.parse(fs.readFileSync(path.join(cfg, 'goals', 'ship.json'), 'utf8'));
    expect(g.checkIns).toHaveLength(1);
    expect(g.checkIns[0].summary).toContain('CORE-TOKEN-XYZ');
  });

  test('memory edit core opens $EDITOR (EDITOR=cat prints and exits)', () => {
    const cfg = tmpDir('p5-edit');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);

    // Seed core so EDITOR=cat has something to print.
    const memDir = path.join(cfg, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'core.md'), 'hello-core\n');

    const r = runCli(['memory', 'edit', 'core'], cfg, { EDITOR: 'cat' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('hello-core');
  });
});
