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

// Turn off per-turn recall (cfg.chat.recall=false). `config set` can't write a
// nested key, so set it directly. Recall prepends "## Relevant recalled context"
// to the user turn, which the mock provider echoes — irrelevant to these tests.
function disableRecall(cfgDir: string) {
  const p = path.join(cfgDir, 'config.json');
  const c = JSON.parse(fs.readFileSync(p, 'utf8'));
  c.chat = { ...(c.chat || {}), recall: false };
  fs.writeFileSync(p, JSON.stringify(c, null, 2));
}

function spawnChat(cfgDir: string, sessionId: string | null, env: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
  const args = ['chat'];
  if (sessionId) { args.push('--session', sessionId); }
  return spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir, ...env },
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

test.describe('Phase 3 — /goal registration', () => {
  test('/goal add creates a goal file with status active', async () => {
    const cfg = tmpDir('p3-add');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);

    const child = spawnChat(cfg, null);
    const sink: string[] = [];
    child.stdout.on('data', d => sink.push(d.toString()));
    child.stderr.on('data', d => sink.push(d.toString()));

    child.stdin.write('/goal add ship-v4 --desc "Ship v4"\n');
    expect(await waitFor(child, sink, '✓ goal ship-v4 added')).toBe(true);

    await endChat(child);

    const p = path.join(cfg, 'goals', 'ship-v4.json');
    expect(fs.existsSync(p)).toBe(true);
    const g = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(g).toMatchObject({ name: 'ship-v4', description: 'Ship v4', status: 'active', sessionId: 'goal:ship-v4' });
    expect(Array.isArray(g.checkIns)).toBe(true);
  });

  test('/goal list returns the active goals', async () => {
    const cfg = tmpDir('p3-list');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);
    expect(runCli(['goal', 'add', 'ship-v4', '--desc', 'Ship v4'], cfg).status).toBe(0);

    const child = spawnChat(cfg, null);
    const sink: string[] = [];
    child.stdout.on('data', d => sink.push(d.toString()));
    child.stderr.on('data', d => sink.push(d.toString()));

    child.stdin.write('/goal\n');
    expect(await waitFor(child, sink, 'ship-v4')).toBe(true);
    expect(sink.join('')).toContain('Ship v4');

    await endChat(child);
  });

  test('single-arg /goal <name> switches chat session context', async () => {
    const cfg = tmpDir('p3-switch');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);
    disableRecall(cfg);   // per-turn recall (roadmap #7) pollutes the mock echo; not under test here
    expect(runCli(['goal', 'add', 'demo', '--desc', 'demo goal'], cfg).status).toBe(0);

    // Start chat WITHOUT --session, so default has no session id. After
    // switching to 'demo', subsequent user turns must persist under
    // <cfg>/sessions/goal:demo.jsonl.
    const child = spawnChat(cfg, null);
    const sink: string[] = [];
    child.stdout.on('data', d => sink.push(d.toString()));
    child.stderr.on('data', d => sink.push(d.toString()));

    child.stdin.write('/goal demo\n');
    expect(await waitFor(child, sink, 'switched to goal: demo')).toBe(true);

    // Send a user message — must land in goal:demo session.
    child.stdin.write('hi from demo\n');
    expect(await waitFor(child, sink, 'mock-reply: hi from demo')).toBe(true);
    await new Promise(r => setTimeout(r, 200));

    await endChat(child);

    const goalSessionPath = path.join(cfg, 'sessions', 'goal:demo.jsonl');
    expect(fs.existsSync(goalSessionPath)).toBe(true);
    const turns = fs.readFileSync(goalSessionPath, 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    // Expect at least one user turn with our message landed in the
    // goal's session (proves the switch took effect).
    const userTurns = turns.filter(t => t.role === 'user');
    expect(userTurns.some(t => t.content === 'hi from demo')).toBe(true);
    // Default-session file MUST NOT exist with this content.
    const defaultPath = path.join(cfg, 'sessions');
    if (fs.existsSync(defaultPath)) {
      const others = fs.readdirSync(defaultPath).filter(n => n !== 'goal:demo.jsonl');
      for (const f of others) {
        const body = fs.readFileSync(path.join(defaultPath, f), 'utf8');
        expect(body).not.toContain('hi from demo');
      }
    }
  });

  test('/goal close <name> done prevents switching afterwards', async () => {
    const cfg = tmpDir('p3-close');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);
    expect(runCli(['goal', 'add', 'old', '--desc', 'legacy'], cfg).status).toBe(0);

    const child = spawnChat(cfg, null);
    const sink: string[] = [];
    child.stdout.on('data', d => sink.push(d.toString()));
    child.stderr.on('data', d => sink.push(d.toString()));

    child.stdin.write('/goal close old done\n');
    expect(await waitFor(child, sink, '✓ goal old closed')).toBe(true);

    child.stdin.write('/goal old\n');
    expect(await waitFor(child, sink, 'cannot switch')).toBe(true);

    await endChat(child);

    const p = path.join(cfg, 'goals', 'old.json');
    const g = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(g.status).toBe('done');
    expect(typeof g.closedAt).toBe('string');
  });

  test('invalid name is rejected with the cron-style error', async () => {
    const cfg = tmpDir('p3-invalid');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);

    // CLI surface — same code path the REPL would take. The spec says
    // the message matches `cron add`'s, which says
    // `name "..." must match /^[A-Za-z0-9_.-]+$/`.
    const r = runCli(['goal', 'add', 'has spaces'], cfg);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/name "has spaces" must match/);

    // No file landed under goals/.
    const goalsDir = path.join(cfg, 'goals');
    if (fs.existsSync(goalsDir)) {
      expect(fs.readdirSync(goalsDir)).not.toContain('has spaces.json');
    }
  });
});
