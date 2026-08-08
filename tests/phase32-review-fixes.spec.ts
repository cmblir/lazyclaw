import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Phase 32 — fixes from the adversarial review of the SSE producer +
// multichannel work: URL-userinfo redaction, Matrix re-delivery dedup,
// Matrix fatal-on-401, and /inbound cost accounting.

const REPO_ROOT = process.cwd();
const CLI = path.join(REPO_ROOT, 'cli.mjs');
function tmpDir(p: string): string { return fs.mkdtempSync(path.join(os.tmpdir(), `lc-${p}-`)); }
function runCli(args: string[], cfgDir: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, POMPOS_CONFIG_DIR: cfgDir, ...env } });
}
async function loadRedact() { return await import(pathToFileURL(path.join(REPO_ROOT, 'mas', 'redact.mjs')).href) as typeof import('../mas/redact.mjs'); }
async function loadMatrix() { return await import(pathToFileURL(path.join(REPO_ROOT, 'channels', 'matrix.mjs')).href) as typeof import('../channels/matrix.mjs'); }

test.describe('Phase 32 — review fixes', () => {
  test('redactSecrets scrubs a password embedded in a URL', async () => {
    const { redactSecrets } = await loadRedact();
    const out = redactSecrets('connect postgres://admin:s3cr3tP4ss@db.internal:5432/app now');
    expect(out).not.toContain('s3cr3tP4ss');
    expect(out).toContain('postgres://admin:[REDACTED]@');
  });

  test('Matrix dedups a re-delivered batch — no double reply', async () => {
    const { MatrixChannel } = await loadMatrix();
    const ch = new MatrixChannel({ homeserver: 'http://x', accessToken: 't', userId: '@bot:x' });
    const sends: string[] = [];
    (ch as unknown as { send: (t: string, x: string) => Promise<void> }).send = async (_t, x) => { sends.push(x); };
    await ch.start(async () => 'reply', { poll: false });
    const sync = { rooms: { join: { '!room:x': { timeline: { events: [
      { type: 'm.room.message', sender: '@u:x', event_id: '$e1', content: { msgtype: 'm.text', body: 'hi' } },
    ] } } } } };
    await ch._simulateInbound(sync);
    await ch._simulateInbound(sync);   // homeserver re-delivers the same batch
    expect(sends).toHaveLength(1);     // replied exactly once
    await ch.stop();
  });

  test('Matrix _fetchSync throws a FATAL error on a 401 (dead token), not a transient one', async () => {
    const server = http.createServer((_req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ errcode: 'M_UNKNOWN_TOKEN' })); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const { MatrixChannel } = await loadMatrix();
      const ch = new MatrixChannel({ homeserver: `http://127.0.0.1:${port}`, accessToken: 'dead', userId: '@bot:x' });
      let code = '';
      try { await ch._fetchSync(); } catch (e) { code = (e as { code?: string }).code || ''; }
      expect(code).toBe('MATRIX_AUTH_FATAL');
    } finally { await new Promise<void>((r) => server.close(() => r())); }
  });

  // NOTE: /inbound cost accounting (review finding #5) is verified by
  // code inspection — the route now mirrors POST /agent exactly (onUsage
  // capture → costFromUsage → accumulateMetricsFromCost), and /agent's
  // cost path is already covered. A dedicated /inbound test would have to
  // replicate the anthropic provider's streaming-SSE wire shape to make
  // usage flow, which tests the mock rather than the fix; omitted on
  // purpose.
});
