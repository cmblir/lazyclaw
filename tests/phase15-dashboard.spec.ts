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
  let port = 0;
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    const nl = buf.indexOf('\n');
    if (nl >= 0 && !port) {
      try { const j = JSON.parse(buf.slice(0, nl)); if (j.port) port = j.port; } catch { /* not the line */ }
    }
  });
  const start = Date.now();
  while (!port && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 50));
  if (!port) {
    child.kill('SIGKILL');
    throw new Error('daemon never bound a port');
  }
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    stop: () => new Promise<void>((resolve) => {
      child.on('close', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 3000);
    }),
  };
}

async function api(daemon: Daemon, path: string, init?: RequestInit) {
  const res = await fetch(daemon.baseUrl + path, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

test.describe('Phase 15 — dashboard daemon routes', () => {
  test('GET /agents returns an empty array on a fresh config dir', async () => {
    const cfg = tmpDir('p15-empty');
    const d = await startDaemon(cfg);
    try {
      const r = await api(d, '/agents');
      expect(r.status).toBe(200);
      expect(r.body).toEqual([]);
    } finally { await d.stop(); }
  });

  test('POST /agents → GET /agents → DELETE /agents/<name> round-trip', async () => {
    const cfg = tmpDir('p15-agent-crud');
    const d = await startDaemon(cfg);
    try {
      const create = await api(d, '/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'planner', role: 'plan things', provider: 'anthropic', model: 'claude-opus-4-7' }),
      });
      expect(create.status).toBe(200);
      expect(create.body.name).toBe('planner');
      expect(create.body.tools).toEqual(['bash', 'read', 'write', 'grep', 'skill_view']);

      const list = await api(d, '/agents');
      expect(list.body.map((a: { name: string }) => a.name)).toEqual(['planner']);

      const dup = await api(d, '/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'planner' }),
      });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('AGENT_EXISTS');

      const del = await api(d, '/agents/planner', { method: 'DELETE' });
      expect(del.status).toBe(200);
      expect(del.body.removed).toBe(true);

      const after = await api(d, '/agents');
      expect(after.body).toEqual([]);
    } finally { await d.stop(); }
  });

  test('PATCH /agents/<name> updates role and tools, bumps updatedAt', async () => {
    const cfg = tmpDir('p15-agent-edit');
    const d = await startDaemon(cfg);
    try {
      await api(d, '/agents', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'planner', role: 'old' }),
      });
      const before = (await api(d, '/agents/planner')).body;
      await new Promise((r) => setTimeout(r, 10));
      const patch = await api(d, '/agents/planner', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'new', tools: ['read', 'grep'] }),
      });
      expect(patch.status).toBe(200);
      expect(patch.body.role).toBe('new');
      expect(patch.body.tools).toEqual(['read', 'grep']);
      expect(patch.body.updatedAt).not.toBe(before.updatedAt);
    } finally { await d.stop(); }
  });

  test('teams routes mirror agent CRUD with agent-ref validation', async () => {
    const cfg = tmpDir('p15-team-crud');
    const d = await startDaemon(cfg);
    try {
      // seed two agents via the daemon — same surface the dashboard uses
      await api(d, '/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'planner' }) });
      await api(d, '/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'backend' }) });

      const create = await api(d, '/teams', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'shop', agents: ['planner', 'backend'], lead: 'planner', slackChannel: 'C12345678' }),
      });
      expect(create.status).toBe(200);
      expect(create.body.lead).toBe('planner');

      const ghost = await api(d, '/teams', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'growth', agents: ['ghost'] }),
      });
      expect(ghost.status).toBe(400);
      expect(ghost.body.code).toBe('TEAM_BAD_AGENT');

      const got = await api(d, '/teams/shop');
      expect(got.body.agents).toEqual(['planner', 'backend']);

      const del = await api(d, '/teams/shop', { method: 'DELETE' });
      expect(del.status).toBe(200);

      const list = await api(d, '/teams');
      expect(list.body).toEqual([]);
    } finally { await d.stop(); }
  });

  test('tasks routes expose read-only listing + done/abandon POSTs', async () => {
    const cfg = tmpDir('p15-task-crud');
    // Seed a real task via the CLI so we don't have to recreate task
    // start's Slack-aware wiring in this test.
    expect(runCli(['agent', 'add', 'planner'], cfg).status).toBe(0);
    expect(runCli(['team', 'add', 'shop', '--agents', 'planner'], cfg).status).toBe(0);
    const open = JSON.parse(runCli(['task', 'start', '--team', 'shop', '--title', 'cleanup'], cfg).stdout);

    const d = await startDaemon(cfg);
    try {
      const list = await api(d, '/tasks');
      expect(list.body.map((t: { id: string }) => t.id)).toContain(open.id);

      const one = await api(d, `/tasks/${open.id}`);
      expect(one.body.title).toBe('cleanup');

      const closed = await api(d, `/tasks/${open.id}/done`, { method: 'POST' });
      expect(closed.status).toBe(200);
      expect(closed.body.status).toBe('done');

      const reread = await api(d, `/tasks/${open.id}`);
      expect(reread.body.status).toBe('done');
    } finally { await d.stop(); }
  });

  // dashboard-shell-motion Task 3 replaced the flat data-tab="…" buttons with
  // a grouped sidebar rendered client-side by web/ui/shell.mjs from the
  // registry in web/ui/nav_model.mjs. A plain fetch() (no browser, no JS
  // execution) can't see the rendered .nav-item buttons — those don't exist
  // until shell.mjs runs — so the invariant this test defends ("every panel
  // is present and reachable") is checked at its actual source of truth:
  // the served HTML has the skeleton shell.mjs mounts into, and the served
  // nav_model.mjs module lists every panel id. This is stronger than the old
  // check (which only pinned 3 of 19 ids): it pins all 21.
  test('GET /dashboard returns the shell skeleton, and every registered panel is reachable via nav_model.mjs', async () => {
    const cfg = tmpDir('p15-html');
    const d = await startDaemon(cfg);
    try {
      const res = await fetch(d.baseUrl + '/dashboard');
      expect(res.ok).toBe(true);
      const html = await res.text();
      // The shell's mount points shell.mjs looks up by id.
      for (const id of ['rail', 'nav-groups', 'nav-marker', 'host', 'burger', 'modal-scrim', 'modal-x']) {
        expect(html).toContain(`id="${id}"`);
      }
      // CSS + JS are split out of the HTML shell (CLAUDE.md §7) and served
      // as same-origin static assets. The references are ABSOLUTE (leading
      // slash): the daemon serves this page at both /dashboard and /dashboard/,
      // so a relative href would resolve to /dashboard/dashboard.css and 404,
      // leaving the page unstyled (fixed in 9c1bd74).
      expect(html).toContain('href="/dashboard.css"');
      expect(html).toContain('src="/dashboard.js"');

      const navModuleSrc = await (await fetch(d.baseUrl + '/ui/nav_model.mjs')).text();
      const before19 = ['chat', 'sessions', 'workflows', 'skills', 'providers', 'rates',
        'metrics', 'doctor', 'config', 'status', 'agents', 'teams', 'tasks', 'team',
        'trainer', 'recall', 'sandbox', 'channels', 'scheduling'];
      for (const id of [...before19, 'approvals', 'gateway']) {
        expect(navModuleSrc).toContain(`id: '${id}'`);
      }
    } finally { await d.stop(); }
  });

  test('GET /dashboard.css and /dashboard.js serve the split-out assets, plus the /ui/*.mjs shell modules', async () => {
    const cfg = tmpDir('p15-assets');
    const d = await startDaemon(cfg);
    try {
      const css = await fetch(d.baseUrl + '/dashboard.css');
      expect(css.ok).toBe(true);
      expect(css.headers.get('content-type')).toContain('text/css');
      expect(await css.text()).toContain('--bg');

      const js = await fetch(d.baseUrl + '/dashboard.js');
      expect(js.ok).toBe(true);
      expect(js.headers.get('content-type')).toContain('javascript');
      // dashboard.js is now the shell entry point (Task 3) — it mounts
      // web/ui/shell.mjs instead of holding the panel loaders itself.
      expect(await js.text()).toContain("mount(");

      // The shell is served as ES modules under /ui/ (Task 2's route) — these
      // are part of the shell surface now, not an implementation detail.
      for (const mod of ['shell.mjs', 'nav_model.mjs', 'dom.mjs', 'modal.mjs']) {
        const r = await fetch(d.baseUrl + '/ui/' + mod);
        expect(r.ok, `/ui/${mod} should be served`).toBe(true);
        expect(r.headers.get('content-type')).toContain('javascript');
      }
    } finally { await d.stop(); }
  });
});
