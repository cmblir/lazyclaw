import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();
const CLI = path.join(REPO_ROOT, 'cli.mjs');

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lc-${prefix}-`));
}

function runCli(args: string[], cfgDir: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, POMPOS_CONFIG_DIR: cfgDir, ...env },
  });
}

test.describe('Phase 7 — channel adapter interface', () => {
  test('base/stub: inbox → handler → outbox round-trip', async () => {
    const stubUrl = pathToFileURL(path.join(REPO_ROOT, 'channels', 'stub.mjs')).href;
    const { StubChannel } = await import(stubUrl);
    const ch = new StubChannel();
    await ch.start(async ({ text }: { text: string }) => `echo:${text}`);
    ch.inbox.push({ threadId: 't1', text: 'hello' });
    ch.inbox.push({ threadId: 't2', text: 'world' });

    // Stub pumps every 5ms; give it a tick to drain.
    await new Promise(r => setTimeout(r, 60));
    expect(ch.outbox).toHaveLength(2);
    expect(ch.outbox.map(o => o.text)).toEqual(['echo:hello', 'echo:world']);
    await ch.stop();
  });

  test('stub respects shared auth + rate-limit gate', async () => {
    const baseUrl = pathToFileURL(path.join(REPO_ROOT, 'channels', 'base.mjs')).href;
    const stubUrl = pathToFileURL(path.join(REPO_ROOT, 'channels', 'stub.mjs')).href;
    const { makeBucketGate } = await import(baseUrl);
    const { StubChannel } = await import(stubUrl);
    const gate = makeBucketGate({ authToken: 'secret-xyz', rateLimit: { capacity: 1, refillPerSec: 0 } });
    const ch = new StubChannel();
    await ch.start(async ({ text }: { text: string }) => `ok:${text}`, { gate });

    // Bad token rejected
    ch.inbox.push({ threadId: 't1', text: 'bad', token: 'nope' });
    // Good token, first one allowed by the 1-token bucket
    ch.inbox.push({ threadId: 't2', text: 'one', token: 'secret-xyz' });
    // Good token, second one — bucket empty → rate_limited
    ch.inbox.push({ threadId: 't3', text: 'two', token: 'secret-xyz' });

    await new Promise(r => setTimeout(r, 80));
    expect(ch.outbox).toHaveLength(3);
    const byId = Object.fromEntries(ch.outbox.map(o => [o.threadId, o]));
    expect(byId.t1.error).toMatch(/unauthorized/);
    expect(byId.t2.text).toBe('ok:one');
    expect(byId.t3.error).toMatch(/rate_limited/);
    await ch.stop();
  });

  test('stub stop is idempotent and clears interval', async () => {
    const stubUrl = pathToFileURL(path.join(REPO_ROOT, 'channels', 'stub.mjs')).href;
    const { StubChannel } = await import(stubUrl);
    const ch = new StubChannel();
    await ch.start(async () => 'r');
    await ch.stop();
    await ch.stop(); // safe to call twice
    // After stop, pushing to inbox does not throw; messages just sit there.
    ch.inbox.push({ threadId: 't', text: 'x' });
    await new Promise(r => setTimeout(r, 30));
    expect(ch.outbox).toHaveLength(0);
  });

  test('HTTP regression: daemon serves /version on a free port (existing behavior unchanged)', async () => {
    // We spawn the daemon as a subprocess so we exercise the same code
    // path users hit. The regression assertion is that the daemon still
    // boots and serves a known endpoint without touching the channel
    // adapter — Phase 7 added channels alongside, not in place of, the
    // existing surface.
    const cfg = tmpDir('p7-http');
    expect(runCli(['config', 'set', 'provider', 'mock'], cfg).status).toBe(0);
    const child = spawn(process.execPath, [CLI, 'daemon', '--port', '0'], {
      env: { ...process.env, POMPOS_CONFIG_DIR: cfg },
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    let port = 0;
    let buf = '';
    const sink: string[] = [];
    child.stdout.on('data', d => {
      const s = d.toString(); sink.push(s); buf += s;
      // Daemon prints exactly one JSON line on stdout once it has bound.
      const nl = buf.indexOf('\n');
      if (nl >= 0 && !port) {
        const line = buf.slice(0, nl);
        try { const j = JSON.parse(line); if (j.port) port = j.port; }
        catch { /* not the line we want */ }
      }
    });
    child.stderr.on('data', d => sink.push(d.toString()));
    // Wait up to 5s for the daemon to bind a port.
    const start = Date.now();
    while (!port && Date.now() - start < 5000) await new Promise(r => setTimeout(r, 50));
    expect(port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${port}/version`);
    expect(res.ok).toBe(true);
    const j = await res.json();
    expect(typeof j.version).toBe('string');
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => { child.on('close', () => resolve()); setTimeout(resolve, 3000); });
  });
});
