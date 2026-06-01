import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';

// Phase 31 — multichannel inbound integration: `matrix listen` is
// registered, and the generic inbound webhook (POST /inbound) bridges any
// relay through the active provider with a pairing gate.

const REPO_ROOT = process.cwd();
const CLI = path.join(REPO_ROOT, 'cli.mjs');
function tmpDir(p: string): string { return fs.mkdtempSync(path.join(os.tmpdir(), `lc-${p}-`)); }
function runCli(args: string[], cfgDir: string) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir } });
}

interface Daemon { baseUrl: string; child: ChildProcessWithoutNullStreams; stop: () => Promise<void>; }
async function startDaemon(cfgDir: string): Promise<Daemon> {
  const child = spawn(process.execPath, [CLI, 'daemon', '--port', '0'], { env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir }, stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
  let port = 0; let buf = '';
  child.stdout.on('data', (d) => { buf += d.toString(); const nl = buf.indexOf('\n'); if (nl >= 0 && !port) { try { const j = JSON.parse(buf.slice(0, nl)); if (j.port) port = j.port; } catch { /* */ } } });
  const start = Date.now();
  while (!port && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 50));
  if (!port) { child.kill('SIGKILL'); throw new Error('daemon never bound'); }
  return { baseUrl: `http://127.0.0.1:${port}`, child, stop: () => new Promise<void>((r) => { child.on('close', () => r()); child.kill('SIGTERM'); setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } r(); }, 3000); }) };
}

test.describe('Phase 31 — multichannel inbound', () => {
  test('matrix is a registered subcommand; bad subcommand prints usage', () => {
    const cfg = tmpDir('p31-mx');
    const r = runCli(['matrix', 'bogus'], cfg);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/matrix listen/);
    expect(r.stderr).toMatch(/MATRIX_/);
  });

  test('POST /inbound bridges a message through the active provider', async () => {
    const cfg = tmpDir('p31-inbound');
    runCli(['config', 'set', 'provider', 'mock'], cfg);
    const d = await startDaemon(cfg);
    try {
      const r = await fetch(`${d.baseUrl}/inbound`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hello there', threadId: 'discord:42' }) });
      expect(r.status).toBe(200);
      const j = await r.json() as { reply: string; threadId: string };
      expect(j.reply).toContain('hello there');   // mock echoes the last user message
      expect(j.threadId).toBe('discord:42');
    } finally { await d.stop(); }
  });

  test('POST /inbound enforces the pairing allowlist on senderId', async () => {
    const cfg = tmpDir('p31-gate');
    runCli(['config', 'set', 'provider', 'mock'], cfg);
    runCli(['pairing', 'add', '999'], cfg);   // now an allowlist exists
    const d = await startDaemon(cfg);
    try {
      const blocked = await fetch(`${d.baseUrl}/inbound`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi', senderId: '111' }) });
      expect(blocked.status).toBe(403);
      const ok = await fetch(`${d.baseUrl}/inbound`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi', senderId: '999' }) });
      expect(ok.status).toBe(200);
    } finally { await d.stop(); }
  });
});
