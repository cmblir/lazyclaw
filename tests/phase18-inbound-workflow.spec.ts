// tests/phase18-inbound-workflow.spec.ts
//
// Roadmap C-4 — an inbound Slack message to a workflow-bound channel triggers
// the stored declarative workflow (with the message as {{input}}) and replies
// with its output. End-to-end over a live daemon. Unbound channels fall through
// to the normal single-shot path (byte-stable).

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
  child.stdout.on('data', (d) => { buf += d.toString(); const nl = buf.indexOf('\n'); if (nl >= 0 && !port) { try { const j = JSON.parse(buf.slice(0, nl)); if (j.port) port = j.port; } catch { /* */ } } });
  const start = Date.now();
  while (!port && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 50));
  if (!port) { child.kill('SIGKILL'); throw new Error('daemon never bound a port'); }
  return {
    baseUrl: `http://127.0.0.1:${port}`, child,
    stop: () => new Promise<void>((resolve) => { child.on('close', () => resolve()); child.kill('SIGTERM'); setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } resolve(); }, 3000); }),
  };
}

const inbound = (d: Daemon, body: unknown) => fetch(d.baseUrl + '/inbound', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test.describe('Phase 18 — inbound Slack triggers a named workflow', () => {
  test('a workflow-bound channel runs the workflow and replies with {{input}}', async () => {
    const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-p18-'));
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
      provider: 'mock',
      workflows: {
        greet: { def: { nodes: [{ id: 'reply', type: 'template', config: { text: 'workflow says: {{input}}' } }] }, channel: 'slack:#auto', replyNode: 'reply' },
      },
    }));
    const daemon = await startDaemon(cfgDir);
    try {
      const res = await inbound(daemon, { text: 'hello there', channel: '#auto' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.workflow).toBe('greet');
      expect(body.reply).toBe('workflow says: hello there');
    } finally { await daemon.stop(); }
  });

  test('an unbound channel falls through to the normal single-shot reply', async () => {
    const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-p18b-'));
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ provider: 'mock' }));
    const daemon = await startDaemon(cfgDir);
    try {
      const res = await inbound(daemon, { text: 'ping', channel: '#nowhere' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.workflow).toBeUndefined();
      expect(body.reply).toBe('mock-reply: ping'); // single-shot mock provider
    } finally { await daemon.stop(); }
  });
});
