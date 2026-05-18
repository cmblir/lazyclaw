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
function spawnLoop(args: string[], cfgDir: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [CLI, 'loop', ...args], {
    env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
}
async function untilTrue(predicate: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await predicate()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return false;
}
function seedMemoryCore(cfgDir: string, body: string) {
  const memDir = path.join(cfgDir, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'core.md'), body);
}
function seedEpisodic(cfgDir: string, slug: string, body: string) {
  const dir = path.join(cfgDir, 'memory', 'episodic');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.md`), body);
}
function loadLoopResult(cfgDir: string, loopId: string) {
  const p = path.join(cfgDir, 'loops', loopId, 'result.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test.describe('Phase 6 — /loop × memory injection', () => {
  test('--use-memory --max 1 places core.md in the system message', () => {
    const cfg = tmpDir('p6-use');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);
    seedMemoryCore(cfg, 'CORE-ALPHA-001');

    const r = runCli(['loop', 'noop', '--max', '1', '--use-memory'], cfg);
    expect(r.status).toBe(0);
    // The foreground loop prints the final result JSON on stdout. The
    // updated mock includes [sys:...] in the reply when system is set.
    const lines = r.stdout.trim().split('\n');
    const tail = JSON.parse(lines[lines.length - 1]);
    expect(tail.lastReply).toContain('CORE-ALPHA-001');
    expect(tail.lastReply).toMatch(/^\[sys:/);
  });

  test('--recall "<query>" with a matching episodic file includes that file content', () => {
    const cfg = tmpDir('p6-recall');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);
    seedEpisodic(cfg, 'deploy-notes', 'EPISODIC-DEPLOY-XYZ ready to ship.');
    seedEpisodic(cfg, 'unrelated', 'ZZZZ-NOT-MATCHED.');

    const r = runCli(['loop', 'plan', '--max', '1', '--recall', 'deploy'], cfg);
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n');
    const tail = JSON.parse(lines[lines.length - 1]);
    expect(tail.lastReply).toContain('EPISODIC-DEPLOY-XYZ');
    expect(tail.lastReply).not.toContain('ZZZZ-NOT-MATCHED');
  });

  test('--recall without --use-memory works on its own', () => {
    const cfg = tmpDir('p6-recall-only');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);
    seedEpisodic(cfg, 'meeting-notes', 'MEETING-RECALL-ABC discussed.');

    const r = runCli(['loop', 'plan', '--max', '1', '--recall', 'meeting'], cfg);
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n');
    const tail = JSON.parse(lines[lines.length - 1]);
    expect(tail.lastReply).toContain('MEETING-RECALL-ABC');
  });

  test('rebuild-per-iter: mutating core.md between iters reaches later iterations', async () => {
    const cfg = tmpDir('p6-rebuild');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);
    seedMemoryCore(cfg, 'CORE-FIRST-AAA');

    // Foreground loop with --max 3 so we have two opportunities for the
    // late mutation to be observed.
    const child = spawnLoop(['delta', '--max', '3', '--use-memory'], cfg);
    const stderr: string[] = [];
    const stdout: string[] = [];
    child.stderr.on('data', d => stderr.push(d.toString()));
    child.stdout.on('data', d => stdout.push(d.toString()));

    // Wait for the first iteration marker, then mutate core.md.
    const sawIter1 = await untilTrue(() => stderr.join('').includes('↻ loop iteration 1/3'), 6000);
    expect(sawIter1).toBe(true);
    seedMemoryCore(cfg, 'CORE-SECOND-BBB');

    // Wait for the loop to finish entirely.
    await new Promise<void>((resolve) => {
      child.on('close', () => resolve());
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 15000);
    });

    // Parse the result JSON line from stdout to find the loop id.
    const trailing = stdout.join('').trim().split('\n').filter(Boolean);
    const finalLine = trailing[trailing.length - 1];
    const final = JSON.parse(finalLine);
    expect(final.iterations).toBe(3);
    const res = loadLoopResult(cfg, final.loopId);
    expect(res).toBeTruthy();

    // The loop session jsonl carries all 3 assistant turns. At least one
    // of iter 2 or iter 3 must contain CORE-SECOND-BBB; iter 1 must
    // contain CORE-FIRST-AAA.
    const sessionPath = path.join(cfg, 'sessions', `loop:${final.loopId}.jsonl`);
    expect(fs.existsSync(sessionPath)).toBe(true);
    const turns = fs.readFileSync(sessionPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const assistantReplies = turns.filter(t => t.role === 'assistant').map(t => t.content);
    expect(assistantReplies.length).toBe(3);
    expect(assistantReplies[0]).toContain('CORE-FIRST-AAA');
    // After mutation, at least one later iteration sees CORE-SECOND-BBB.
    expect(assistantReplies[1].includes('CORE-SECOND-BBB') || assistantReplies[2].includes('CORE-SECOND-BBB')).toBe(true);
  });
});
