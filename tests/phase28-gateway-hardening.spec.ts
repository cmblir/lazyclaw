import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Phase 28 — security hardening regressions for the device gateway, from
// the adversarial review: bounded ChallengeRegistry, pruned pending
// requests, per-device SSE cap, auth-token bypass via dot-segment path
// confusion, and 413 on oversized bodies.

const REPO_ROOT = process.cwd();
const CLI = path.join(REPO_ROOT, 'cli.mjs');

function tmpDir(p: string): string { return fs.mkdtempSync(path.join(os.tmpdir(), `lc-${p}-`)); }
async function loadDeviceAuth() {
  return await import(pathToFileURL(path.join(REPO_ROOT, 'gateway', 'device_auth.mjs')).href) as typeof import('../gateway/device_auth.mjs');
}
async function loadGateway() {
  return await import(pathToFileURL(path.join(REPO_ROOT, 'gateway', 'http_gateway.mjs')).href) as typeof import('../gateway/http_gateway.mjs');
}

// Minimal ServerResponse stub: captures the status; write/end/once are no-ops.
function mockRes() {
  return {
    status: 0,
    headers: null as Record<string, string> | null,
    writeHead(s: number, h?: Record<string, string>) { this.status = s; this.headers = h || null; return this; },
    write() { return true; },
    end() { return this; },
    once() { /* no close fired in-test → entry stays in the set */ },
  };
}

test.describe('Phase 28 — gateway hardening', () => {
  test('ChallengeRegistry enforces a hard cap (no unbounded growth)', async () => {
    const { ChallengeRegistry } = await loadDeviceAuth();
    const reg = new ChallengeRegistry({ maxPending: 5, sweepEvery: 1000 });
    for (let i = 0; i < 200; i++) reg.create();
    // @ts-expect-error — reach into the private ledger for the assertion.
    expect(reg._pending.size).toBeLessThanOrEqual(5);
  });

  test('ChallengeRegistry._sweep drops entries outside the skew window', async () => {
    const { ChallengeRegistry } = await loadDeviceAuth();
    const reg = new ChallengeRegistry({ maxSkewMs: 1000 });
    // @ts-expect-error private
    reg._pending.set('fresh', 10_000);
    // @ts-expect-error private
    reg._pending.set('stale', 1); // ~10s old relative to nowMs below
    // @ts-expect-error private
    reg._sweep(10_000);
    // @ts-expect-error private
    expect(reg._pending.has('fresh')).toBe(true);
    // @ts-expect-error private
    expect(reg._pending.has('stale')).toBe(false);
  });

  test('PairingStore prunes pending requests older than the TTL on requestPairing', async () => {
    const cfg = tmpDir('p28-prune');
    const { PairingStore } = await loadDeviceAuth();
    const store = new PairingStore(cfg);
    // Inject a stale pending request directly, then trigger a prune via a
    // fresh requestPairing.
    // @ts-expect-error private
    store._data.requests['pr_old'] = { requestId: 'pr_old', deviceId: 'sha256:old', status: 'pending', createdAt: '2000-01-01T00:00:00.000Z' };
    // @ts-expect-error private
    store._persist();
    store.requestPairing({ deviceId: 'sha256:new' });
    const pending = store.pending();
    expect(pending.some((r) => r.deviceId === 'sha256:old')).toBe(false); // pruned
    expect(pending.some((r) => r.deviceId === 'sha256:new')).toBe(true);
  });

  test('SSE per-device cap rejects the 9th concurrent stream with 429', async () => {
    const cfg = tmpDir('p28-sse-cap');
    const { PairingStore, ChallengeRegistry } = await loadDeviceAuth();
    const store = new PairingStore(cfg);
    const deviceId = 'sha256:capdev';
    const { requestId } = store.requestPairing({ deviceId });
    const { token } = store.approve(requestId);

    const { createGateway } = await loadGateway();
    const gw = createGateway({ configDir: cfg, challengeRegistry: new ChallengeRegistry() });
    const mkReq = () => ({ method: 'GET', url: '/gateway/events', headers: { authorization: `Bearer ${token}`, 'x-device-id': deviceId }, once() {} });
    const readBody = async () => '';
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) {
      const res = mockRes();
      await gw.handle(mkReq(), res, { readBody });
      statuses.push(res.status);
    }
    // First 8 accepted (SSE → 200), 9th over the per-device cap → 429.
    expect(statuses.slice(0, 8).every((s) => s === 200)).toBe(true);
    expect(statuses[8]).toBe(429);
  });
});

// ── integration: auth-token bypass + 413, against a live daemon ─────────
interface Daemon { baseUrl: string; port: number; child: ChildProcessWithoutNullStreams; stop: () => Promise<void>; }
async function startDaemonAuth(cfgDir: string, token: string): Promise<Daemon> {
  const child = spawn(process.execPath, [CLI, 'daemon', '--port', '0', '--auth-token', token], {
    env: { ...process.env, POMPOS_CONFIG_DIR: cfgDir }, stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let port = 0; let buf = '';
  child.stdout.on('data', (d) => { buf += d.toString(); const nl = buf.indexOf('\n'); if (nl >= 0 && !port) { try { const j = JSON.parse(buf.slice(0, nl)); if (j.port) port = j.port; } catch { /* */ } } });
  const start = Date.now();
  while (!port && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 50));
  if (!port) { child.kill('SIGKILL'); throw new Error('daemon never bound'); }
  return { baseUrl: `http://127.0.0.1:${port}`, port, child, stop: () => new Promise<void>((r) => { child.on('close', () => r()); child.kill('SIGTERM'); setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } r(); }, 3000); }) };
}

// Raw request that does NOT normalize the path (fetch would collapse `..`).
function rawGet(port: number, rawPath: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: rawPath }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode || 0 }));
    });
    req.on('error', reject);
    req.end();
  });
}

test.describe('Phase 28 — gateway auth-bypass + 413 (integration)', () => {
  test('dot-segment path cannot skip the auth-token gate; real gateway path still bypasses it', async () => {
    const cfg = tmpDir('p28-bypass');
    const d = await startDaemonAuth(cfg, 'secret-token');
    try {
      // /version requires the daemon token → 401 without it.
      expect((await rawGet(d.port, '/version')).status).toBe(401);
      // /gateway/../version normalizes to /version → must ALSO be 401, not bypassed.
      expect((await rawGet(d.port, '/gateway/../version')).status).toBe(401);
      // A genuine gateway route bypasses the daemon token (device-auth is its own gate).
      const ch = await fetch(`${d.baseUrl}/gateway/connect/challenge`, { method: 'POST' });
      expect(ch.status).toBe(200);
    } finally { await d.stop(); }
  });

  test('oversized /gateway/connect body returns 413, not 500', async () => {
    const cfg = tmpDir('p28-413');
    const d = await startDaemonAuth(cfg, 'secret-token');
    try {
      const big = 'x'.repeat(1_200_000); // > 1 MiB cap
      const r = await fetch(`${d.baseUrl}/gateway/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blob: big }) });
      expect(r.status).toBe(413);
    } finally { await d.stop(); }
  });
});
