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
    env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir, ...env },
  });
}

function spawnChat(cfgDir: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [CLI, 'chat'], {
    env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
}

async function waitFor(child: ChildProcessWithoutNullStreams, sink: string[], needle: string, ms = 4000): Promise<boolean> {
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

test.describe('Phase 9 — agent registry', () => {
  test('agent add writes a JSON file with the full default tool whitelist', async () => {
    const cfg = tmpDir('p9-add');
    const r = runCli(['agent', 'add', 'planner', '--role', 'Project planner', '--provider', 'claude-cli', '--model', 'claude-opus-4-7'], cfg);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({
      name: 'planner',
      displayName: 'Planner',
      role: 'Project planner',
      provider: 'claude-cli',
      model: 'claude-opus-4-7',
      tools: ['bash', 'read', 'write', 'grep'],
      version: 1,
    });
    const onDisk = JSON.parse(fs.readFileSync(path.join(cfg, 'agents', 'planner.json'), 'utf8'));
    expect(onDisk.name).toBe('planner');
    expect(onDisk.tools).toEqual(['bash', 'read', 'write', 'grep']);
  });

  test('agent add rejects an unknown tool name', async () => {
    const cfg = tmpDir('p9-badtool');
    const r = runCli(['agent', 'add', 'x', '--tools', 'bash,read,fly'], cfg);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown tool/);
  });

  test('agent add refuses to overwrite an existing agent', async () => {
    const cfg = tmpDir('p9-dup');
    expect(runCli(['agent', 'add', 'planner'], cfg).status).toBe(0);
    const r = runCli(['agent', 'add', 'planner'], cfg);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/already exists/);
  });

  test('agent list returns a JSON array sorted by name', async () => {
    const cfg = tmpDir('p9-list');
    expect(runCli(['agent', 'add', 'planner'], cfg).status).toBe(0);
    expect(runCli(['agent', 'add', 'backend'], cfg).status).toBe(0);
    expect(runCli(['agent', 'add', 'frontend'], cfg).status).toBe(0);
    const r = runCli(['agent', 'list'], cfg);
    expect(r.status).toBe(0);
    const arr = JSON.parse(r.stdout);
    expect(arr.map((a: { name: string }) => a.name)).toEqual(['backend', 'frontend', 'planner']);
  });

  test('agent show prints the stored record verbatim', async () => {
    const cfg = tmpDir('p9-show');
    expect(runCli(['agent', 'add', 'planner', '--role', 'P'], cfg).status).toBe(0);
    const r = runCli(['agent', 'show', 'planner'], cfg);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ name: 'planner', role: 'P' });
  });

  test('agent edit patches only the named fields and bumps updatedAt', async () => {
    const cfg = tmpDir('p9-edit');
    expect(runCli(['agent', 'add', 'planner', '--role', 'old'], cfg).status).toBe(0);
    const before = JSON.parse(runCli(['agent', 'show', 'planner'], cfg).stdout);

    // small wait so updatedAt timestamp can advance at ms precision
    await new Promise(r => setTimeout(r, 10));

    const r = runCli(['agent', 'edit', 'planner', '--role', 'new', '--tools', 'read,grep'], cfg);
    expect(r.status).toBe(0);
    const after = JSON.parse(r.stdout);
    expect(after.role).toBe('new');
    expect(after.tools).toEqual(['read', 'grep']);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.updatedAt).not.toBe(before.updatedAt);
  });

  test('agent remove deletes the on-disk record', async () => {
    const cfg = tmpDir('p9-remove');
    expect(runCli(['agent', 'add', 'planner'], cfg).status).toBe(0);
    expect(fs.existsSync(path.join(cfg, 'agents', 'planner.json'))).toBe(true);
    const r = runCli(['agent', 'remove', 'planner'], cfg);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(cfg, 'agents', 'planner.json'))).toBe(false);

    // Removing again should exit 2 with a clear error.
    const r2 = runCli(['agent', 'remove', 'planner'], cfg);
    expect(r2.status).toBe(2);
    expect(r2.stderr).toMatch(/no agent/);
  });

  test('lazyclaw agent "<prompt>" still works (legacy one-shot path is intact)', async () => {
    const cfg = tmpDir('p9-legacy');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);
    // The string "hello" is NOT in AGENT_REG_SUBS, so dispatch must fall
    // through to the legacy cmdAgent path which streams a mock reply.
    const r = runCli(['agent', 'hello world'], cfg);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/mock-reply/);
  });

  test('/agent slash command lists, adds, shows, and removes inside the REPL', async () => {
    const cfg = tmpDir('p9-slash');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);

    const child = spawnChat(cfg);
    const sink: string[] = [];
    child.stdout.on('data', d => sink.push(d.toString()));
    child.stderr.on('data', d => sink.push(d.toString()));

    child.stdin.write('/agent list\n');
    expect(await waitFor(child, sink, 'no agents registered')).toBe(true);

    child.stdin.write('/agent add planner Project planner agent\n');
    expect(await waitFor(child, sink, '✓ added agent planner')).toBe(true);

    child.stdin.write('/agent list\n');
    expect(await waitFor(child, sink, '• planner')).toBe(true);

    child.stdin.write('/agent show planner\n');
    expect(await waitFor(child, sink, '"name": "planner"')).toBe(true);

    child.stdin.write('/agent remove planner\n');
    expect(await waitFor(child, sink, '✓ removed agent planner')).toBe(true);

    await endChat(child);

    // Final disk state: no agents directory entries.
    const dir = path.join(cfg, 'agents');
    expect(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0).toBe(true);
  });
});
