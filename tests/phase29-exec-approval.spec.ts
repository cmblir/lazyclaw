import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Phase 29 — SSE event producer: remote exec-approval over the gateway.
//   - gateway.requestApproval broadcasts exec.approval.requested and
//     returns a Promise settled by resolveApproval (device) or timeout.
//   - tool_runner gates sensitive tools (bash/write) on an approve hook.
//   - end-to-end: POST /exec/request (daemon, authed) ↔ SSE ↔ device
//     POST /gateway/exec/resolve.

const REPO_ROOT = process.cwd();
const CLI = path.join(REPO_ROOT, 'cli.mjs');
function tmpDir(p: string): string { return fs.mkdtempSync(path.join(os.tmpdir(), `lc-${p}-`)); }

async function loadGateway() {
  return await import(pathToFileURL(path.join(REPO_ROOT, 'gateway', 'http_gateway.mjs')).href) as typeof import('../gateway/http_gateway.mjs');
}
async function loadDeviceAuth() {
  return await import(pathToFileURL(path.join(REPO_ROOT, 'gateway', 'device_auth.mjs')).href) as typeof import('../gateway/device_auth.mjs');
}
async function loadRunner() {
  return await import(pathToFileURL(path.join(REPO_ROOT, 'mas', 'tool_runner.mjs')).href) as typeof import('../mas/tool_runner.mjs');
}

test.describe('Phase 29A — gateway approval registry (unit)', () => {
  test('requestApproval is pending until resolved; resolve settles the promise', async () => {
    const { createGateway } = await loadGateway();
    const { ChallengeRegistry } = await loadDeviceAuth();
    const gw = createGateway({ configDir: tmpDir('p29a'), challengeRegistry: new ChallengeRegistry() });
    const { id, promise } = gw.requestApproval({ tool: 'bash', summary: 'echo hi' }, { timeoutMs: 5000 });
    expect(gw.pendingApprovals().some((a) => a.id === id)).toBe(true);
    const r = gw.resolveApproval(id, 'approve', 'dev1');
    expect(r.ok).toBe(true);
    const settled = await promise;
    expect(settled).toMatchObject({ id, approved: true, by: 'dev1' });
    expect(gw.pendingApprovals()).toHaveLength(0);
    gw.close();
  });

  test('resolving an unknown id is a no-op 404-style result', async () => {
    const { createGateway } = await loadGateway();
    const { ChallengeRegistry } = await loadDeviceAuth();
    const gw = createGateway({ configDir: tmpDir('p29a2'), challengeRegistry: new ChallengeRegistry() });
    expect(gw.resolveApproval('ap_nope', 'approve').ok).toBe(false);
    gw.close();
  });

  test('approval times out to denied when no device resolves', async () => {
    const { createGateway } = await loadGateway();
    const { ChallengeRegistry } = await loadDeviceAuth();
    const gw = createGateway({ configDir: tmpDir('p29a3'), challengeRegistry: new ChallengeRegistry() });
    const { promise } = gw.requestApproval({ tool: 'bash' }, { timeoutMs: 1000 });
    const settled = await promise;
    expect(settled.approved).toBe(false);
    expect(settled.reason).toBe('timeout');
    gw.close();
  });

  test('approval summary is redacted before it leaves the process', async () => {
    const { createGateway } = await loadGateway();
    const { ChallengeRegistry } = await loadDeviceAuth();
    const gw = createGateway({ configDir: tmpDir('p29a4'), challengeRegistry: new ChallengeRegistry() });
    gw.requestApproval({ tool: 'bash', summary: 'curl -H "Authorization: Bearer sk-live1234567890abcdef"' });
    const view = gw.pendingApprovals()[0];
    expect(view.summary).not.toContain('sk-live1234567890abcdef');
    gw.close();
  });
});

test.describe('Phase 29B — tool_runner approve hook', () => {
  const agent = { name: 'a', tools: ['bash', 'read', 'write', 'grep'] };

  test('a denial blocks a sensitive tool (bash) without executing it', async () => {
    const runner = await loadRunner();
    const cwd = tmpDir('p29b-deny');
    const res = await runner.runTool({ agent, tool: 'bash', args: { command: 'echo SHOULD_NOT_RUN' }, cwd, approve: async () => ({ approved: false, reason: 'nope' }) });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('TOOL_DENIED_APPROVAL');
  });

  test('an approval lets a sensitive tool run', async () => {
    const runner = await loadRunner();
    const cwd = tmpDir('p29b-allow');
    const res = await runner.runTool({ agent, tool: 'bash', args: { command: 'echo OK' }, cwd, approve: async () => ({ approved: true }) });
    expect(res.ok).toBe(true);
  });

  test('a read-only tool is NOT gated even when an approve hook is present', async () => {
    const runner = await loadRunner();
    const cwd = tmpDir('p29b-read');
    fs.writeFileSync(path.join(cwd, 'f.txt'), 'hello');
    let called = false;
    const res = await runner.runTool({ agent, tool: 'read', args: { path: 'f.txt' }, cwd, approve: async () => { called = true; return { approved: false }; } });
    expect(res.ok).toBe(true);          // read ran despite the (would-deny) hook
    expect(called).toBe(false);         // hook never consulted for a read
  });
});

// ── end-to-end over a live daemon ───────────────────────────────────────
interface Daemon { baseUrl: string; child: ChildProcessWithoutNullStreams; stop: () => Promise<void>; }
async function startDaemon(cfgDir: string): Promise<Daemon> {
  const child = spawn(process.execPath, [CLI, 'daemon', '--port', '0'], { env: { ...process.env, POMPOS_CONFIG_DIR: cfgDir }, stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
  let port = 0; let buf = '';
  child.stdout.on('data', (d) => { buf += d.toString(); const nl = buf.indexOf('\n'); if (nl >= 0 && !port) { try { const j = JSON.parse(buf.slice(0, nl)); if (j.port) port = j.port; } catch { /* */ } } });
  const start = Date.now();
  while (!port && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 50));
  if (!port) { child.kill('SIGKILL'); throw new Error('daemon never bound'); }
  return { baseUrl: `http://127.0.0.1:${port}`, child, stop: () => new Promise<void>((r) => { child.on('close', () => r()); child.kill('SIGTERM'); setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } r(); }, 3000); }) };
}

async function approvedDevice(baseUrl: string, cfgDir: string) {
  const da = await loadDeviceAuth();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const deviceId = da.deviceIdFromPublicKey(pubPem);
  const sign = (nonce: string) => {
    const payload = da.buildSignPayload({ deviceId, clientId: 'c', clientMode: 'node', role: 'node', scopes: ['chat'], signedAtMs: Date.now(), token: '', nonce, platform: 'ios', deviceFamily: 'phone' });
    return { payload, signature: crypto.sign(null, Buffer.from(payload), privateKey).toString('base64'), publicKey: pubPem, nonce };
  };
  const ch1 = await (await fetch(`${baseUrl}/gateway/connect/challenge`, { method: 'POST' })).json() as { nonce: string };
  const r1 = await (await fetch(`${baseUrl}/gateway/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sign(ch1.nonce)) })).json() as { requestId: string };
  // approve via PairingStore directly (same configDir the daemon reads)
  const store = new da.PairingStore(cfgDir);
  store.approve(r1.requestId);
  const ch2 = await (await fetch(`${baseUrl}/gateway/connect/challenge`, { method: 'POST' })).json() as { nonce: string };
  const r2 = await (await fetch(`${baseUrl}/gateway/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sign(ch2.nonce)) })).json() as { token: string };
  return { deviceId, token: r2.token };
}

test.describe('Phase 29C — exec approval end-to-end', () => {
  test('POST /exec/request broadcasts to SSE and resolves when the device approves', async () => {
    const cfg = tmpDir('p29c');
    const d = await startDaemon(cfg);
    try {
      const dev = await approvedDevice(d.baseUrl, cfg);
      const authHeaders = { authorization: `Bearer ${dev.token}`, 'x-device-id': dev.deviceId };

      const ac = new AbortController();
      const sse = await fetch(`${d.baseUrl}/gateway/events`, { headers: authHeaders, signal: ac.signal });
      const reader = sse.body!.getReader();

      // Fire the approval request (do NOT await yet — it long-polls).
      const reqPromise = fetch(`${d.baseUrl}/exec/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'bash', summary: 'rm -rf /tmp/x', timeoutMs: 8000 }) });

      // Read the SSE stream until the request event arrives, capture its id.
      let id = '';
      const startedAt = Date.now();
      while (!id && Date.now() - startedAt < 8000) {
        const { value } = await reader.read();
        const chunk = Buffer.from(value!).toString('utf8');
        const m = chunk.match(/event: exec\.approval\.requested\ndata: (\{.*\})/);
        if (m) { id = JSON.parse(m[1]).id; }
      }
      expect(id).toMatch(/^ap_/);

      // Device approves.
      const resolve = await fetch(`${d.baseUrl}/gateway/exec/resolve`, { method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ id, decision: 'approve' }) });
      expect(resolve.status).toBe(200);

      // The long-polling request now settles approved.
      const result = await (await reqPromise).json() as { approved: boolean; by: string };
      expect(result.approved).toBe(true);
      expect(result.by).toBe(dev.deviceId);
      ac.abort();
    } finally { await d.stop(); }
  });
});
