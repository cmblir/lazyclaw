// tests/phase17-workflow-run-route.spec.ts
//
// POST /workflows/run executes a DECLARATIVE workflow on the daemon. The
// daemon derives caps from config (never the workflow), so a set/template
// workflow runs without any provider/network. End-to-end route wiring check.

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const CLI = path.join(process.cwd(), 'cli.mjs');

interface Daemon { baseUrl: string; child: ChildProcessWithoutNullStreams; stop: () => Promise<void>; }

async function startDaemon(cfgDir: string): Promise<Daemon> {
  const child = spawn(process.execPath, [CLI, 'daemon', '--port', '0'], {
    env: { ...process.env, POMPOS_CONFIG_DIR: cfgDir }, stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let port = 0; let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString(); const nl = buf.indexOf('\n');
    if (nl >= 0 && !port) { try { const j = JSON.parse(buf.slice(0, nl)); if (j.port) port = j.port; } catch { /* not the port line */ } }
  });
  const start = Date.now();
  while (!port && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 50));
  if (!port) { child.kill('SIGKILL'); throw new Error('daemon never bound a port'); }
  return {
    baseUrl: `http://127.0.0.1:${port}`, child,
    stop: () => new Promise<void>((resolve) => {
      child.on('close', () => resolve()); child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 3000);
    }),
  };
}

const post = (d: Daemon, body: unknown) => fetch(d.baseUrl + '/workflows/run', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test.describe('Phase 17 — POST /workflows/run', () => {
  let daemon: Daemon;
  test.beforeAll(async () => { daemon = await startDaemon(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-p17-'))); });
  test.afterAll(async () => { if (daemon) await daemon.stop(); });

  test('executes a declarative set→template workflow', async () => {
    const res = await post(daemon, { workflow: { nodes: [
      { id: 'who', type: 'set', config: { value: 'world' } },
      { id: 'msg', type: 'template', config: { text: 'hi {{who}}' } },
    ] } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.session.msg).toBe('hi world');
    expect(body.results.map((r: { id: string }) => r.id)).toEqual(['who', 'msg']);
  });

  test('rejects a malformed definition with 400', async () => {
    const res = await post(daemon, { workflow: { nodes: [] } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.code || '')).toMatch(/^WF_/);
  });

  test('a posted workflow cannot use the ungranted shell type', async () => {
    const res = await post(daemon, { workflow: { nodes: [{ id: 'x', type: 'shell', config: { command: 'id' } }] } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/unknown node type "shell"/);
  });
});
