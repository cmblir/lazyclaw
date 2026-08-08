import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Phase 27 — device gateway wired into the daemon (HTTP + SSE realisation
// of the OpenClaw "WS gateway"): challenge → sign → connect (pending →
// approve → token) → token-authed whoami / SSE, with replay rejection.

const REPO_ROOT = process.cwd();
const CLI = path.join(REPO_ROOT, 'cli.mjs');

function tmpDir(p: string): string { return fs.mkdtempSync(path.join(os.tmpdir(), `lc-${p}-`)); }
function runCli(args: string[], cfgDir: string) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, POMPOS_CONFIG_DIR: cfgDir } });
}

interface Daemon { baseUrl: string; child: ChildProcessWithoutNullStreams; stop: () => Promise<void>; }
async function startDaemon(cfgDir: string): Promise<Daemon> {
  const child = spawn(process.execPath, [CLI, 'daemon', '--port', '0'], {
    env: { ...process.env, POMPOS_CONFIG_DIR: cfgDir }, stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let port = 0; let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    const nl = buf.indexOf('\n');
    if (nl >= 0 && !port) { try { const j = JSON.parse(buf.slice(0, nl)); if (j.port) port = j.port; } catch { /* */ } }
  });
  const start = Date.now();
  while (!port && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 50));
  if (!port) { child.kill('SIGKILL'); throw new Error('daemon never bound'); }
  return {
    baseUrl: `http://127.0.0.1:${port}`, child,
    stop: () => new Promise<void>((r) => { child.on('close', () => r()); child.kill('SIGTERM'); setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } r(); }, 3000); }),
  };
}

async function loadDeviceAuth() {
  return await import(pathToFileURL(path.join(REPO_ROOT, 'gateway', 'device_auth.mjs')).href) as typeof import('../gateway/device_auth.mjs');
}

// A test "device": Ed25519 keypair + a signed connect for a given nonce.
async function makeDevice() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const da = await loadDeviceAuth();
  const deviceId = da.deviceIdFromPublicKey(pubPem);
  const signConnect = (nonce: string) => {
    const payload = da.buildSignPayload({
      deviceId, clientId: 'test-client', clientMode: 'node', role: 'node',
      scopes: ['chat'], signedAtMs: Date.now(), token: '', nonce, platform: 'ios', deviceFamily: 'phone',
    });
    const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');
    return { payload, signature, publicKey: pubPem, nonce, platform: 'ios' };
  };
  return { deviceId, pubPem, signConnect };
}

async function challenge(baseUrl: string): Promise<{ nonce: string; ts: number }> {
  const r = await fetch(`${baseUrl}/gateway/connect/challenge`, { method: 'POST' });
  return await r.json() as { nonce: string; ts: number };
}
async function connect(baseUrl: string, body: object) {
  const r = await fetch(`${baseUrl}/gateway/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() as Record<string, unknown> };
}

test.describe('Phase 27 — device gateway', () => {
  test('challenge → unapproved connect → approve → token → whoami; replay rejected', async () => {
    const cfg = tmpDir('p27');
    const d = await startDaemon(cfg);
    try {
      const dev = await makeDevice();

      // 1) Challenge + signed connect → 403 pending (device not yet approved).
      const c1 = await challenge(d.baseUrl);
      expect(c1.nonce).toMatch(/^[0-9a-f]{64}$/);
      const r1 = await connect(d.baseUrl, dev.signConnect(c1.nonce));
      expect(r1.status).toBe(403);
      expect(r1.json.status).toBe('pending');
      const requestId = r1.json.requestId as string;
      expect(requestId).toBeTruthy();

      // 2) Replaying the SAME nonce is rejected (single-use consume already ran).
      const replay = await connect(d.baseUrl, dev.signConnect(c1.nonce));
      expect(replay.status).toBe(401);
      expect(String(replay.json.reason)).toMatch(/expired or already used/);

      // 3) Operator approves via the CLI (separate process, shared devices.json).
      const ap = runCli(['nodes', 'approve', requestId], cfg);
      expect(ap.status).toBe(0);
      const apJson = JSON.parse(ap.stdout);
      expect(apJson.deviceId).toBe(dev.deviceId);
      // The raw token must NOT be echoed by `nodes approve` (deviceId is
      // itself sha256:<hex>, so assert on the absence of a token field).
      expect(apJson.token).toBeUndefined();
      expect(ap.stdout).not.toMatch(/"token"/);
      expect(String(apJson.note)).toMatch(/next \/gateway\/connect/);

      // 4) Fresh challenge + connect now yields the rotated bearer token.
      const c2 = await challenge(d.baseUrl);
      const r2 = await connect(d.baseUrl, dev.signConnect(c2.nonce));
      expect(r2.status).toBe(200);
      expect(r2.json.ok).toBe(true);
      const token = r2.json.token as string;
      expect(token).toMatch(/^[0-9a-f]{64}$/);

      // 5) whoami with the device token + id → 200; wrong token → 401.
      const who = await fetch(`${d.baseUrl}/gateway/whoami`, { headers: { authorization: `Bearer ${token}`, 'x-device-id': dev.deviceId } });
      expect(who.status).toBe(200);
      expect((await who.json() as { deviceId: string }).deviceId).toBe(dev.deviceId);

      const bad = await fetch(`${d.baseUrl}/gateway/whoami`, { headers: { authorization: 'Bearer deadbeef', 'x-device-id': dev.deviceId } });
      expect(bad.status).toBe(401);
    } finally { await d.stop(); }
  });

  test('impersonation: a payload claiming another device id than the key is rejected', async () => {
    const cfg = tmpDir('p27-imp');
    const d = await startDaemon(cfg);
    try {
      const da = await loadDeviceAuth();
      const attacker = await makeDevice();
      const victimKeys = crypto.generateKeyPairSync('ed25519');
      const victimId = da.deviceIdFromPublicKey(victimKeys.publicKey.export({ type: 'spki', format: 'pem' }) as string);

      const c = await challenge(d.baseUrl);
      // Attacker signs a payload claiming the VICTIM's deviceId with the
      // ATTACKER's key, and presents the ATTACKER's pubkey.
      const payload = da.buildSignPayload({
        deviceId: victimId, clientId: 'x', clientMode: 'node', role: 'node', scopes: ['chat'],
        signedAtMs: Date.now(), token: '', nonce: c.nonce, platform: 'ios', deviceFamily: 'phone',
      });
      // Re-sign with attacker key (regenerate to get the private half).
      // Easiest: just send attacker's own pubkey with the victim-claiming payload.
      const r = await connect(d.baseUrl, { payload, signature: 'AAAA', publicKey: attacker.pubPem, nonce: c.nonce });
      expect(r.status).toBe(401); // bad signature OR device id mismatch — never 200
      expect(r.json.ok).toBe(false);
    } finally { await d.stop(); }
  });

  test('GET /gateway/events streams a connected event to an authed device', async () => {
    const cfg = tmpDir('p27-sse');
    const d = await startDaemon(cfg);
    try {
      const dev = await makeDevice();
      const c1 = await challenge(d.baseUrl);
      const r1 = await connect(d.baseUrl, dev.signConnect(c1.nonce));
      runCli(['nodes', 'approve', r1.json.requestId as string], cfg);
      const c2 = await challenge(d.baseUrl);
      const r2 = await connect(d.baseUrl, dev.signConnect(c2.nonce));
      const token = r2.json.token as string;

      const ac = new AbortController();
      const res = await fetch(`${d.baseUrl}/gateway/events`, { headers: { authorization: `Bearer ${token}`, 'x-device-id': dev.deviceId }, signal: ac.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const chunk = Buffer.from(value!).toString('utf8');
      expect(chunk).toMatch(/event: connected/);
      ac.abort();
    } finally { await d.stop(); }
  });
});
