import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

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

async function untilTrue(predicate: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await predicate()) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}

test.describe('Phase 2 — pompos loop detached', () => {
  test('--detach returns within 500ms and lists the loop', async () => {
    const cfg = tmpDir('p2-detach');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);

    const t0 = Date.now();
    const r = runCli(['loop', 'hello', '--max', '3', '--detach'], cfg);
    const elapsed = Date.now() - t0;
    expect(r.status).toBe(0);
    expect(elapsed).toBeLessThan(500);
    const out = JSON.parse(r.stdout.trim());
    expect(typeof out.loopId).toBe('string');
    expect(typeof out.pid).toBe('number');
    expect(typeof out.statePath).toBe('string');

    // List immediately — must include the loop with status running or completed.
    const list = runCli(['loops', 'list'], cfg);
    expect(list.status).toBe(0);
    const items = JSON.parse(list.stdout);
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(out.loopId);
    expect(['running', 'completed']).toContain(items[0].status);

    // Wait for completion, then verify result.
    const finished = await untilTrue(() => {
      const r2 = runCli(['loops', 'show', out.loopId], cfg);
      if (r2.status !== 0) return false;
      const o = JSON.parse(r2.stdout);
      return o.meta?.status === 'completed';
    }, 5000);
    expect(finished).toBe(true);
  });

  test('kill mid-loop flips meta.status to killed', async () => {
    const cfg = tmpDir('p2-kill');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);

    const r = runCli(['loop', 'long', '--max', '50', '--detach'], cfg);
    expect(r.status).toBe(0);
    const { loopId, pid } = JSON.parse(r.stdout.trim());
    expect(pid).toBeGreaterThan(0);

    // Wait for the worker to start emitting iterations so we know it's alive.
    await untilTrue(() => {
      const log = path.join(cfg, 'loops', loopId, 'iterations.log');
      return fs.existsSync(log) && fs.statSync(log).size > 0;
    }, 3000);

    const k = runCli(['loops', 'kill', loopId], cfg);
    expect(k.status).toBe(0);
    const killOut = JSON.parse(k.stdout.trim());
    expect(killOut.signal).toBe('SIGTERM');

    // Wait for the pid to actually be gone.
    const gone = await untilTrue(() => {
      try { process.kill(pid, 0); return false; }
      catch (e: any) { return e.code === 'ESRCH'; }
    }, 5000);
    expect(gone).toBe(true);

    // Status should be killed.
    const show = runCli(['loops', 'show', loopId], cfg);
    expect(show.status).toBe(0);
    const o = JSON.parse(show.stdout);
    expect(['killed', 'failed']).toContain(o.meta?.status);
  });

  test('loops tail streams new iteration lines until completion', async () => {
    const cfg = tmpDir('p2-tail');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);

    const r = runCli(['loop', 'tick', '--max', '4', '--detach'], cfg);
    expect(r.status).toBe(0);
    const { loopId } = JSON.parse(r.stdout.trim());

    const tail = spawn(process.execPath, [CLI, 'loops', 'tail', loopId, '--poll-ms', '50', '--max-wait-ms', '8000'], {
      env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfg },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    tail.stdout.on('data', d => { stdout += d.toString(); });
    await new Promise<void>((resolve) => {
      tail.on('close', () => resolve());
      setTimeout(() => { try { tail.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 8500);
    });
    // Should observe all four iteration markers.
    for (let i = 1; i <= 4; i++) {
      expect(stdout).toContain(`"iteration":${i}`);
    }
  });

  test('worker crash via LC_FAIL_AT_ITER lands meta.status failed', async () => {
    const cfg = tmpDir('p2-crash');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);

    const r = runCli(['loop', 'crashy', '--max', '5', '--detach'], cfg, { LC_FAIL_AT_ITER: '2' });
    expect(r.status).toBe(0);
    const { loopId, pid } = JSON.parse(r.stdout.trim());

    // Wait for the worker to die.
    const gone = await untilTrue(() => {
      try { process.kill(pid, 0); return false; }
      catch (e: any) { return e.code === 'ESRCH'; }
    }, 5000);
    expect(gone).toBe(true);

    // After the worker is gone, `loops show` should mark status `failed`
    // even if the worker had no chance to flip it itself (reconcileStatus
    // synthesises it from a dead pid).
    const show = runCli(['loops', 'show', loopId], cfg);
    expect(show.status).toBe(0);
    const o = JSON.parse(show.stdout);
    expect(o.meta?.status).toBe('failed');
  });
});
