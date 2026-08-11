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
import * as crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();
const tmpDir = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `lc-${p}-`));
const loadDeviceAuth = async () => import(pathToFileURL(path.join(REPO_ROOT, 'gateway', 'device_auth.mjs')).href) as typeof import('../gateway/device_auth.mjs');
const loadGateway = async () => import(pathToFileURL(path.join(REPO_ROOT, 'gateway', 'http_gateway.mjs')).href) as typeof import('../gateway/http_gateway.mjs');

function mockRes() {
  return {
    status: 0,
    body: undefined as string | undefined,
    writeHead(s: number) { this.status = s; return this; },
    write() { return true; },
    end(payload?: string) { this.body = payload; return this; },
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

  // A real browser (web/ui/pairing.mjs) sends its public key as base64 DER
  // SPKI — the direct base64 encoding of subtle.exportKey('spki', ...), NOT
  // a PEM string. Before this fix, /gateway/connect passed that base64 text
  // straight into deviceIdFromPublicKey, which treats any string argument as
  // PEM (gateway/device_auth.mjs's toSpkiDer) and threw on it, so the route
  // answered 400 'invalid public key' for every real browser client — no
  // dashboard could ever complete a handshake. Mirrors the normalization
  // daemon/routes/devices_pair.mjs already had for the same field.
  test('a signed connect whose publicKey is base64 DER SPKI (the browser\'s real wire format) succeeds', async () => {
    const cfg = tmpDir('p30-connect-b64');
    const da = await loadDeviceAuth();
    const { PairingStore, ChallengeRegistry, buildSignPayload } = da;
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    const pubB64 = der.toString('base64');
    const deviceId = da.deviceIdFromPublicKey(der);

    // Pre-approved, so a correctly-parsed key reaches 200 with a minted
    // token — not merely past the 400 gate into some other status.
    const store = new PairingStore(cfg);
    const { requestId } = store.requestPairing({ deviceId });
    store.approve(requestId, {});

    const challengeRegistry = new ChallengeRegistry();
    const { nonce } = challengeRegistry.create();
    const payload = buildSignPayload({
      deviceId, clientId: 'pompos-dashboard', clientMode: 'dashboard', role: '',
      scopes: [], signedAtMs: Date.now(), token: '', nonce,
      platform: 'browser', deviceFamily: 'dashboard',
    });
    const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');

    const { createGateway } = await loadGateway();
    const gw = createGateway({ configDir: cfg, challengeRegistry });
    const res = mockRes();
    const req = { method: 'POST', url: '/gateway/connect', headers: {}, once() { /* no-op */ } };
    await gw.handle(req, res, {
      readBody: async () => JSON.stringify({ payload, signature, publicKey: pubB64, nonce, platform: 'browser' }),
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body!) as { ok: boolean; deviceId: string; token: string };
    expect(body.ok).toBe(true);
    expect(body.deviceId).toBe(deviceId);
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(0);
  });

  // Companion to the base64 case above: the PEM representation other
  // callers may still send must keep working after the fix — the
  // normalization branches on a `-----BEGIN` prefix, so this proves that
  // branch, not just the base64 one, still reaches 200.
  test('a signed connect whose publicKey is a PEM string still succeeds', async () => {
    const cfg = tmpDir('p30-connect-pem');
    const da = await loadDeviceAuth();
    const { PairingStore, ChallengeRegistry, buildSignPayload } = da;
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const deviceId = da.deviceIdFromPublicKey(pubPem);

    const store = new PairingStore(cfg);
    const { requestId } = store.requestPairing({ deviceId });
    store.approve(requestId, {});

    const challengeRegistry = new ChallengeRegistry();
    const { nonce } = challengeRegistry.create();
    const payload = buildSignPayload({
      deviceId, clientId: 'pompos-dashboard', clientMode: 'dashboard', role: '',
      scopes: [], signedAtMs: Date.now(), token: '', nonce,
      platform: 'browser', deviceFamily: 'dashboard',
    });
    const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');

    const { createGateway } = await loadGateway();
    const gw = createGateway({ configDir: cfg, challengeRegistry });
    const res = mockRes();
    const req = { method: 'POST', url: '/gateway/connect', headers: {}, once() { /* no-op */ } };
    await gw.handle(req, res, {
      readBody: async () => JSON.stringify({ payload, signature, publicKey: pubPem, nonce, platform: 'browser' }),
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body!) as { ok: boolean; deviceId: string; token: string };
    expect(body.ok).toBe(true);
    expect(body.deviceId).toBe(deviceId);
  });

  // Fix round 1 (Important 2) — a pending request pre-created WITHOUT a
  // signed payload (e.g. the daemon's unsigned POST /devices/pair bootstrap
  // route, which always records role:'') must be re-stamped with the
  // device's real role/scopes the moment it completes an actual signed
  // /gateway/connect — otherwise the signed capability is silently
  // discarded and the device ends up trusted as a full (non-read-only)
  // approver despite never having claimed that.
  test('a pending request created with role:"" is re-stamped from the signed connect payload', async () => {
    const cfg = tmpDir('p30-restamp');
    const da = await loadDeviceAuth();
    const { PairingStore, ChallengeRegistry, buildSignPayload } = da;
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const deviceId = da.deviceIdFromPublicKey(pubPem);

    // Simulate the bootstrap route: a pending request with no capability.
    const store = new PairingStore(cfg);
    const { requestId } = store.requestPairing({ deviceId, role: '', scopes: [] });

    const challengeRegistry = new ChallengeRegistry();
    const { nonce } = challengeRegistry.create();
    const payload = buildSignPayload({
      deviceId, clientId: 'dashboard', clientMode: 'browser', role: 'read-only',
      scopes: ['exec:read'], signedAtMs: Date.now(), token: '', nonce,
      platform: 'browser', deviceFamily: 'desktop',
    });
    const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');

    const { createGateway } = await loadGateway();
    const gw = createGateway({ configDir: cfg, challengeRegistry });
    const res = mockRes();
    const req = { method: 'POST', url: '/gateway/connect', headers: {}, once() { /* no-op */ } };
    await gw.handle(req, res, {
      readBody: async () => JSON.stringify({ payload, signature, publicKey: pubPem, nonce, platform: 'browser' }),
    });

    expect(res.status).toBe(403); // still unapproved — this only proves the re-stamp
    const body = JSON.parse(res.body!) as { status: string; requestId: string };
    expect(body.status).toBe('pending');
    expect(body.requestId).toBe(requestId); // the SAME request — no duplicate minted

    const restamped = new PairingStore(cfg).pendingForDevice(deviceId);
    expect(restamped?.role).toBe('read-only');
    expect(restamped?.scopes).toEqual(['exec:read']);
  });

  // Fix round 2 (Important, introduced by round 1's fix) — the re-stamp above
  // must be monotonic: fill an EMPTY stored role/scopes, but never overwrite
  // an already-set one. Without this, the device itself (it holds the
  // private key) could reconnect with a signed role:'' AFTER the operator
  // reviews "read-only" in `pompos nodes pending` but BEFORE they approve,
  // silently downgrading the stored role to '' — which the exec-resolve gate
  // treats as full authority (it denies only an EXPLICIT "read-only").
  test('a pending request already "read-only" is NOT reset to "" by a later signed reconnect', async () => {
    const cfg = tmpDir('p30-restamp-noclear');
    const da = await loadDeviceAuth();
    const { PairingStore, ChallengeRegistry, buildSignPayload } = da;
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const deviceId = da.deviceIdFromPublicKey(pubPem);

    // The device's FIRST connect already claimed read-only; the request is
    // stored that way (simulated directly here rather than round-tripping
    // through /gateway/connect, which the previous test already covers).
    const store = new PairingStore(cfg);
    store.requestPairing({ deviceId, role: 'read-only', scopes: ['exec:read'] });

    const challengeRegistry = new ChallengeRegistry();
    const { nonce } = challengeRegistry.create();
    // The SAME device reconnects, this time signing an empty role — an
    // attempt (deliberate or not) to erase its own read-only marker.
    const payload = buildSignPayload({
      deviceId, clientId: 'dashboard', clientMode: 'browser', role: '',
      scopes: [], signedAtMs: Date.now(), token: '', nonce,
      platform: 'browser', deviceFamily: 'desktop',
    });
    const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');

    const { createGateway } = await loadGateway();
    const gw = createGateway({ configDir: cfg, challengeRegistry });
    const res = mockRes();
    const req = { method: 'POST', url: '/gateway/connect', headers: {}, once() { /* no-op */ } };
    await gw.handle(req, res, {
      readBody: async () => JSON.stringify({ payload, signature, publicKey: pubPem, nonce, platform: 'browser' }),
    });

    expect(res.status).toBe(403);
    // Re-read from a FRESH PairingStore instance — a disk read, not the
    // in-memory `store` used to create the original request.
    const stored = new PairingStore(cfg).pendingForDevice(deviceId);
    expect(stored?.role).toBe('read-only');
    expect(stored?.scopes).toEqual(['exec:read']);
  });

  test('a pending request already "read-only" is NOT widened by a different signed role', async () => {
    const cfg = tmpDir('p30-restamp-nowiden');
    const da = await loadDeviceAuth();
    const { PairingStore, ChallengeRegistry, buildSignPayload } = da;
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const deviceId = da.deviceIdFromPublicKey(pubPem);

    const store = new PairingStore(cfg);
    store.requestPairing({ deviceId, role: 'read-only', scopes: ['exec:read'] });

    const challengeRegistry = new ChallengeRegistry();
    const { nonce } = challengeRegistry.create();
    // A different NON-EMPTY role — the monotonic rule must reject widening
    // just as firmly as it rejects clearing to ''.
    const payload = buildSignPayload({
      deviceId, clientId: 'dashboard', clientMode: 'browser', role: 'approver',
      scopes: ['exec:write'], signedAtMs: Date.now(), token: '', nonce,
      platform: 'browser', deviceFamily: 'desktop',
    });
    const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');

    const { createGateway } = await loadGateway();
    const gw = createGateway({ configDir: cfg, challengeRegistry });
    const res = mockRes();
    const req = { method: 'POST', url: '/gateway/connect', headers: {}, once() { /* no-op */ } };
    await gw.handle(req, res, {
      readBody: async () => JSON.stringify({ payload, signature, publicKey: pubPem, nonce, platform: 'browser' }),
    });

    expect(res.status).toBe(403);
    const stored = new PairingStore(cfg).pendingForDevice(deviceId);
    expect(stored?.role).toBe('read-only');
    expect(stored?.scopes).toEqual(['exec:read']);
  });
});
