import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = process.cwd();
const CLI = path.join(REPO_ROOT, 'cli.mjs');

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lc-${prefix}-`));
}

function runCli(args: string[], cfgDir: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LAZYCLAW_CONFIG_DIR: cfgDir,
      // Block the OS-level launchd / crontab install so test runs don't
      // mutate the developer's real scheduler. The cfg.cron table is
      // still written so all the visible assertions hold.
      LAZYCLAW_SKIP_CRON_INSTALL: '1',
      ...env,
    },
  });
}

test.describe('Phase 4 — /goal × cron', () => {
  test('goal add --cron writes both the goal file and a cron entry', () => {
    const cfg = tmpDir('p4-add');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);

    const r = runCli(['goal', 'add', 'x', '--desc', 'tracked', '--cron', '* * * * *'], cfg);
    expect(r.status).toBe(0);

    // goal file is present
    expect(fs.existsSync(path.join(cfg, 'goals', 'x.json'))).toBe(true);

    // cron config carries goal-x and points at `lazyclaw goal tick x`
    const list = runCli(['cron', 'list'], cfg);
    expect(list.status).toBe(0);
    const out = JSON.parse(list.stdout);
    const job = out.jobs.find((j: any) => j.name === 'goal-x');
    expect(job).toBeTruthy();
    expect(job.schedule).toBe('* * * * *');
    expect(job.command).toEqual(['lazyclaw', 'goal', 'tick', 'x']);
  });

  test('goal tick --force runs one iteration and stores a check-in', () => {
    const cfg = tmpDir('p4-tick');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);
    expect(runCli(['goal', 'add', 'x', '--desc', 'ship the thing'], cfg).status).toBe(0);

    const r = runCli(['goal', 'tick', 'x', '--force'], cfg);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.iterations).toBe(1);
    // mock provider replies with `mock-reply: <last user content>`, and
    // the tick prompt ends with "What's the next concrete step?", so
    // the reply must mention that line.
    expect(out.reply).toContain("What's the next concrete step?");

    const g = JSON.parse(fs.readFileSync(path.join(cfg, 'goals', 'x.json'), 'utf8'));
    expect(g.checkIns).toHaveLength(1);
    expect(g.checkIns[0].summary).toContain('mock-reply');
    expect(typeof g.checkIns[0].at).toBe('string');
  });

  test('goal close removes both the active state and the cron entry', () => {
    const cfg = tmpDir('p4-close');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);
    expect(runCli(['goal', 'add', 'x', '--desc', 'y', '--cron', '* * * * *'], cfg).status).toBe(0);

    // sanity — both present
    let list = runCli(['cron', 'list'], cfg);
    expect(JSON.parse(list.stdout).jobs.find((j: any) => j.name === 'goal-x')).toBeTruthy();

    const r = runCli(['goal', 'close', 'x', 'done'], cfg);
    expect(r.status).toBe(0);

    const g = JSON.parse(fs.readFileSync(path.join(cfg, 'goals', 'x.json'), 'utf8'));
    expect(g.status).toBe('done');

    list = runCli(['cron', 'list'], cfg);
    expect(JSON.parse(list.stdout).jobs.find((j: any) => j.name === 'goal-x')).toBeUndefined();
  });

  test('stale tick: closed goal exits 0 without calling the provider', () => {
    const cfg = tmpDir('p4-stale');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);
    expect(runCli(['goal', 'add', 'x', '--desc', 'y'], cfg).status).toBe(0);
    expect(runCli(['goal', 'close', 'x', 'done'], cfg).status).toBe(0);

    const r = runCli(['goal', 'tick', 'x'], cfg);
    expect(r.status).toBe(0);
    // No JSON ok output — silent exit. And no second checkIn added.
    expect(r.stdout.trim()).toBe('');
    const g = JSON.parse(fs.readFileSync(path.join(cfg, 'goals', 'x.json'), 'utf8'));
    expect(g.checkIns).toHaveLength(0);
  });

  test('tick on missing goal exits 0 silently (orphan cron tolerance)', () => {
    const cfg = tmpDir('p4-orphan');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);
    const r = runCli(['goal', 'tick', 'nope'], cfg);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });
});
