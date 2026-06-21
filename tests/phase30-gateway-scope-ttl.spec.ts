// tests/phase30-gateway-scope-ttl.spec.ts
//
// Roadmap #6b enforcement at the gateway: a read-only device may observe but
// cannot resolve an exec approval (the one mutating gateway action), and an
// expired device token (TTL) is rejected on every authenticated route. Both are
// backward-compatible — a legacy role-less device keeps the prior behaviour.

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();
const tmpDir = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `lc-${p}-`));
const loadDeviceAuth = async () => import(pathToFileURL(path.join(REPO_ROOT, 'gateway', 'device_auth.mjs')).href) as typeof import('../gateway/device_auth.mjs');
const loadGateway = async () => import(pathToFileURL(path.join(REPO_ROOT, 'gateway', 'http_gateway.mjs')).href) as typeof import('../gateway/http_gateway.mjs');

function mockRes() {
  return {
    status: 0,
    writeHead(s: number) { this.status = s; return this; },
    write() { return true; },
    end() { return this; },
    once() { /* no-op */ },
  };
}
const mkReq = (method: string, url: string, token: string, deviceId: string) =>
  ({ method, url, headers: { authorization: `Bearer ${token}`, 'x-device-id': deviceId }, once() {} });

test.describe('Phase 30 — gateway scope + TTL enforcement', () => {
  test('a read-only device cannot resolve an exec approval (403)', async () => {
    const cfg = tmpDir('p30-ro');
    const { PairingStore, ChallengeRegistry } = await loadDeviceAuth();
    const store = new PairingStore(cfg);
    const deviceId = 'sha256:ro';
    const { requestId } = store.requestPairing({ deviceId, role: 'read-only', scopes: ['exec:read'] });
    const { token } = store.approve(requestId, {});
    const { createGateway } = await loadGateway();
    const gw = createGateway({ configDir: cfg, challengeRegistry: new ChallengeRegistry() });
    const res = mockRes();
    await gw.handle(mkReq('POST', '/gateway/exec/resolve', token, deviceId), res, { readBody: async () => JSON.stringify({ id: 'ap_x', decision: 'approve' }) });
    expect(res.status).toBe(403);
  });

  test('a default (legacy, role-less) device passes the scope gate', async () => {
    const cfg = tmpDir('p30-legacy');
    const { PairingStore, ChallengeRegistry } = await loadDeviceAuth();
    const store = new PairingStore(cfg);
    const deviceId = 'sha256:legacy';
    const { requestId } = store.requestPairing({ deviceId }); // no role
    const { token } = store.approve(requestId, {});
    const { createGateway } = await loadGateway();
    const gw = createGateway({ configDir: cfg, challengeRegistry: new ChallengeRegistry() });
    const res = mockRes();
    await gw.handle(mkReq('POST', '/gateway/exec/resolve', token, deviceId), res, { readBody: async () => JSON.stringify({ id: 'ap_missing', decision: 'approve' }) });
    expect(res.status).not.toBe(403); // past the gate (404 for the missing approval id)
    expect(res.status).not.toBe(401);
  });

  test('an expired device token is rejected (401) via the injected clock', async () => {
    const cfg = tmpDir('p30-ttl');
    const { PairingStore, ChallengeRegistry } = await loadDeviceAuth();
    const store = new PairingStore(cfg);
    const deviceId = 'sha256:ttl';
    const { requestId } = store.requestPairing({ deviceId });
    const { token } = store.approve(requestId, { ttlMs: 1000, nowMs: 0 }); // expires at 1000
    const { createGateway } = await loadGateway();
    const gw = createGateway({ configDir: cfg, challengeRegistry: new ChallengeRegistry(), nowFn: () => 2000 }); // past expiry
    const res = mockRes();
    await gw.handle(mkReq('GET', '/gateway/whoami', token, deviceId), res, { readBody: async () => '' });
    expect(res.status).toBe(401);
  });

  test('a non-expired token still authenticates (TTL boundary)', async () => {
    const cfg = tmpDir('p30-live');
    const { PairingStore, ChallengeRegistry } = await loadDeviceAuth();
    const store = new PairingStore(cfg);
    const deviceId = 'sha256:live';
    const { requestId } = store.requestPairing({ deviceId });
    const { token } = store.approve(requestId, { ttlMs: 1000, nowMs: 0 });
    const { createGateway } = await loadGateway();
    const gw = createGateway({ configDir: cfg, challengeRegistry: new ChallengeRegistry(), nowFn: () => 500 }); // before expiry
    const res = mockRes();
    await gw.handle(mkReq('GET', '/gateway/whoami', token, deviceId), res, { readBody: async () => '' });
    expect(res.status).toBe(200);
  });
});
