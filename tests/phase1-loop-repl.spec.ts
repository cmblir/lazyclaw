import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';

const REPO_ROOT = process.cwd();
const CLI = path.join(REPO_ROOT, 'cli.mjs');

function tmpConfigDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-loop-'));
}

function runCli(args: string[], cfgDir: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, POMPOS_CONFIG_DIR: cfgDir, ...env },
  });
}

function spawnChat(cfgDir: string, sessionId: string, env: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
  // Plain (non-TTY) mode: stdin is a pipe so the test feeds /loop & /exit
  // line by line. The CLI's REPL exits cleanly on /exit.
  return spawn(process.execPath, [CLI, 'chat', '--session', sessionId], {
    env: { ...process.env, POMPOS_CONFIG_DIR: cfgDir, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
}

async function waitForStdoutToContain(child: ChildProcessWithoutNullStreams, sink: string[], needle: string, ms = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (sink.join('').includes(needle)) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return false;
}

function loadSessionTurns(cfgDir: string, sessionId: string): Array<{ role: string, content: string, ts?: number }> {
  const p = path.join(cfgDir, 'sessions', `${sessionId}.jsonl`);
  if (!fs.existsSync(p)) return [];
  const out: Array<{ role: string, content: string, ts?: number }> = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* ignore */ }
  }
  return out;
}

async function endChat(child: ChildProcessWithoutNullStreams): Promise<void> {
  try { child.stdin.write('/exit\n'); child.stdin.end(); } catch { /* already gone */ }
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.on('close', () => resolve());
    // Belt-and-braces: kill after 3s in case /exit didn't take.
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
  });
}

test.describe('Phase 1 — /loop REPL', () => {
  test('runs exactly --max iterations and persists all turns', async () => {
    const dir = tmpConfigDir();
    expect(runCli(['config', 'set', 'provider', 'mock'], dir).status).toBe(0);

    const sessionId = 'loop-basic';
    const child = spawnChat(dir, sessionId);
    const sink: string[] = [];
    child.stdout.on('data', d => sink.push(d.toString()));
    child.stderr.on('data', d => sink.push(d.toString()));

    child.stdin.write('/loop "say hi" --max 2\n');
    // Wait for both iteration markers — they appear on stderr.
    expect(await waitForStdoutToContain(child, sink, '↻ loop iteration 1/2')).toBe(true);
    expect(await waitForStdoutToContain(child, sink, '↻ loop iteration 2/2')).toBe(true);
    expect(await waitForStdoutToContain(child, sink, 'mock-reply: say hi')).toBe(true);

    await endChat(child);

    const turns = loadSessionTurns(dir, sessionId).filter(t => t.role !== 'system');
    // 2 iterations × (user + assistant) = 4 turns (the always-on guard system
    // turn is filtered out above; the mock now prefixes the reply with [sys:…]).
    expect(turns.length).toBe(4);
    expect(turns[0]).toMatchObject({ role: 'user', content: 'say hi' });
    expect(turns[1].role).toBe('assistant');
    expect(turns[1].content).toContain('mock-reply: say hi');
    expect(turns[2]).toMatchObject({ role: 'user', content: 'say hi' });
    expect(turns[3].role).toBe('assistant');
    expect(turns[3].content).toContain('mock-reply: say hi');
  });

  test('no args prints usage and consumes no provider call', async () => {
    const dir = tmpConfigDir();
    expect(runCli(['config', 'set', 'provider', 'mock'], dir).status).toBe(0);

    const sessionId = 'loop-usage';
    const child = spawnChat(dir, sessionId);
    const sink: string[] = [];
    child.stdout.on('data', d => sink.push(d.toString()));
    child.stderr.on('data', d => sink.push(d.toString()));

    child.stdin.write('/loop\n');
    expect(await waitForStdoutToContain(child, sink, 'usage: /loop')).toBe(true);
    // mock-reply must NOT appear — usage path is a no-op against the provider.
    await new Promise(r => setTimeout(r, 200));
    expect(sink.join('')).not.toContain('mock-reply:');

    await endChat(child);

    const turns = loadSessionTurns(dir, sessionId).filter(t => t.role !== 'system');
    expect(turns.length).toBe(0);
  });

  test('--max above ceiling is rejected without provider calls', async () => {
    const dir = tmpConfigDir();
    expect(runCli(['config', 'set', 'provider', 'mock'], dir).status).toBe(0);

    const sessionId = 'loop-cap';
    const child = spawnChat(dir, sessionId);
    const sink: string[] = [];
    child.stdout.on('data', d => sink.push(d.toString()));
    child.stderr.on('data', d => sink.push(d.toString()));

    child.stdin.write('/loop "x" --max 999\n');
    expect(await waitForStdoutToContain(child, sink, 'exceeds ceiling 50')).toBe(true);
    await new Promise(r => setTimeout(r, 200));
    expect(sink.join('')).not.toContain('mock-reply:');

    await endChat(child);

    expect(loadSessionTurns(dir, sessionId).filter(t => t.role !== 'system').length).toBe(0);
  });

  test('--until short-circuits when assistant matches', async () => {
    const dir = tmpConfigDir();
    expect(runCli(['config', 'set', 'provider', 'mock'], dir).status).toBe(0);

    const sessionId = 'loop-until';
    const child = spawnChat(dir, sessionId);
    const sink: string[] = [];
    child.stdout.on('data', d => sink.push(d.toString()));
    child.stderr.on('data', d => sink.push(d.toString()));

    // Mock provider returns `mock-reply: <last-user-content>`. The
    // prompt "count up DONE" makes the assistant turn contain "DONE"
    // on iteration 1, so the loop must stop after exactly one turn.
    child.stdin.write('/loop "count up DONE" --max 5 --until "DONE"\n');
    expect(await waitForStdoutToContain(child, sink, 'loop stopped by --until')).toBe(true);
    expect(sink.join('')).toContain('↻ loop iteration 1/5');
    expect(sink.join('')).not.toContain('↻ loop iteration 2/5');

    await endChat(child);

    const turns = loadSessionTurns(dir, sessionId).filter(t => t.role !== 'system');
    // Exactly one user + one assistant pair
    expect(turns.length).toBe(2);
    expect(turns[0].role).toBe('user');
    expect(turns[1].role).toBe('assistant');
    expect(turns[1].content).toContain('DONE');
  });

  test('Ctrl-C mid-loop leaves only completed pairs in the session jsonl', async () => {
    const dir = tmpConfigDir();
    expect(runCli(['config', 'set', 'provider', 'mock'], dir).status).toBe(0);

    const sessionId = 'loop-sigint';
    const child = spawnChat(dir, sessionId);
    const sink: string[] = [];
    child.stdout.on('data', d => sink.push(d.toString()));
    child.stderr.on('data', d => sink.push(d.toString()));

    child.stdin.write('/loop "say hi" --max 10\n');
    // Wait until at least one iteration has fully completed so we know
    // the loop is running, then send SIGINT.
    expect(await waitForStdoutToContain(child, sink, '↻ loop iteration 1/10')).toBe(true);
    child.kill('SIGINT');
    // Give the engine time to roll back any in-flight iteration.
    await new Promise(r => setTimeout(r, 300));

    await endChat(child);

    const turns = loadSessionTurns(dir, sessionId).filter(t => t.role !== 'system');
    // Every entry must come in a user/assistant pair — no orphan.
    expect(turns.length).toBeGreaterThanOrEqual(2);
    expect(turns.length % 2).toBe(0);
    for (let i = 0; i < turns.length; i += 2) {
      expect(turns[i].role).toBe('user');
      expect(turns[i + 1].role).toBe('assistant');
    }
    // Did not run all 10 iterations (the sink only saw a few).
    expect(turns.length).toBeLessThan(20);
  });
});
