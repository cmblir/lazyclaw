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

// A signed /gateway/connect body, exactly as web/ui/pairing.mjs builds one.
// `signedAtMs` is a parameter because verifyConnect measures freshness against
// the gateway's injected clock — a test that moves that clock has to sign
// against the same instant or the handshake fails on skew instead of on the
// thing under test.
function signedConnect(
  da: typeof import('../gateway/device_auth.mjs'),
  keys: crypto.KeyPairKeyObjectResult,
  nonce: string,
  role: string,
  scopes: string[] = [],
  signedAtMs: number = Date.now(),
) {
  const pubPem = keys.publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const deviceId = da.deviceIdFromPublicKey(pubPem);
  const payload = da.buildSignPayload({
    deviceId, clientId: 'pompos-dashboard', clientMode: 'dashboard', role, scopes,
    signedAtMs, token: '', nonce, platform: 'browser', deviceFamily: 'dashboard',
  });
  const signature = crypto.sign(null, Buffer.from(payload), keys.privateKey).toString('base64');
  return {
    deviceId,
    body: JSON.stringify({ payload, signature, publicKey: pubPem, nonce, platform: 'browser' }),
  };
}

const connectReq = () => ({ method: 'POST', url: '/gateway/connect', headers: {}, once() { /* no-op */ } });

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

  // Task 5, fix round 1 — a non-string publicKey must not reach Buffer.from()
  // below: that throws a raw TypeError, which escapes gw.handle() uncaught
  // and becomes a 500 in daemon.mjs's outer catch, reflecting Node's internal
  // error message back to the caller. A malformed body is this handler's own
  // concern and must stay its existing 400, matching
  // daemon/routes/devices_pair.mjs's identical guard on the same field.
  test('a non-string publicKey (number) is the handler\'s own 400, not a raw 500', async () => {
    const cfg = tmpDir('p30-connect-badkey-number');
    const { ChallengeRegistry, PairingStore } = await loadDeviceAuth();
    const challengeRegistry = new ChallengeRegistry();
    const { nonce } = challengeRegistry.create();
    const { createGateway } = await loadGateway();
    const gw = createGateway({ configDir: cfg, challengeRegistry });
    const res = mockRes();
    const req = { method: 'POST', url: '/gateway/connect', headers: {}, once() { /* no-op */ } };
    await gw.handle(req, res, {
      readBody: async () => JSON.stringify({ payload: 'x', signature: 'y', publicKey: 123, nonce }),
    });
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body!) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('payload, signature, publicKey and nonce are required');
    // No device or pairing request was created as a side effect.
    expect(new PairingStore(cfg).pending()).toEqual([]);
    expect(new PairingStore(cfg).devicesList()).toEqual([]);
  });

  test('a non-string publicKey (object) is the handler\'s own 400, not a raw 500', async () => {
    const cfg = tmpDir('p30-connect-badkey-object');
    const { ChallengeRegistry, PairingStore } = await loadDeviceAuth();
    const challengeRegistry = new ChallengeRegistry();
    const { nonce } = challengeRegistry.create();
    const { createGateway } = await loadGateway();
    const gw = createGateway({ configDir: cfg, challengeRegistry });
    const res = mockRes();
    const req = { method: 'POST', url: '/gateway/connect', headers: {}, once() { /* no-op */ } };
    await gw.handle(req, res, {
      readBody: async () => JSON.stringify({ payload: 'x', signature: 'y', publicKey: { not: 'a string' }, nonce }),
    });
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body!) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('payload, signature, publicKey and nonce are required');
    expect(new PairingStore(cfg).pending()).toEqual([]);
    expect(new PairingStore(cfg).devicesList()).toEqual([]);
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

  // ── Final round, CRITICAL — the role gate must not be defeatable by
  // spelling. `role` rides the device's OWN signed payload and used to be
  // stored and compared verbatim against the single string 'read-only', so a
  // device picked whether the gate applied to it: `pompos nodes pending` and
  // the Devices panel showed the operator "Read-Only" while that device could
  // resolve any pending exec approval (i.e. auto-approve an `rm -rf` for any
  // agent). Two halves are asserted per case: the role is NORMALIZED at the one
  // ingest point (so the stored value is what the operator reviewed), and the
  // gate is an ALLOWLIST (so a role nobody recognises is refused, not waved
  // through). ─────────────────────────────────────────────────────────────
  const NEAR_MISS_ROLES: Array<[string, string]> = [
    ['read-only', 'read-only'],
    ['Read-Only', 'read-only'],
    ['read-only ', 'read-only'],
    [' read-only', 'read-only'],
    ['READ-ONLY', 'read-only'],
    ['read_only', 'read_only'],   // not a synonym — an unrecognised role
    ['admin', 'admin'],           // invented outright
  ];

  for (const [declared, stored] of NEAR_MISS_ROLES) {
    test(`a device declaring role ${JSON.stringify(declared)} cannot resolve an exec approval`, async () => {
      const cfg = tmpDir('p30-role-gate');
      const da = await loadDeviceAuth();
      const { PairingStore, ChallengeRegistry } = da;
      const keys = crypto.generateKeyPairSync('ed25519');
      const challengeRegistry = new ChallengeRegistry();
      const { nonce } = challengeRegistry.create();
      const { deviceId, body } = signedConnect(da, keys, nonce, declared, ['exec:read']);

      const { createGateway } = await loadGateway();
      const gw = createGateway({ configDir: cfg, challengeRegistry });

      // The device's first signed connect records the pairing request…
      const connect = mockRes();
      await gw.handle(connectReq(), connect, { readBody: async () => body });
      expect(connect.status).toBe(403);

      // …with the NORMALIZED role, which is what the operator reviews before
      // approving. (Reverting the normalization fails right here.)
      const store = new PairingStore(cfg);
      const pending = store.pendingForDevice(deviceId);
      expect(pending?.role).toBe(stored);
      const { token } = store.approve(pending!.requestId, {});
      expect(new PairingStore(cfg).deviceInfo(deviceId)?.role).toBe(stored);

      // A real approval is now waiting on a human.
      const { id } = gw.requestApproval({ tool: 'bash', agentId: 'dev', summary: 'rm -rf /tmp/x' });

      const res = mockRes();
      await gw.handle(mkReq('POST', '/gateway/exec/resolve', token, deviceId), res, {
        readBody: async () => JSON.stringify({ id, decision: 'approve' }),
      });
      expect(res.status).toBe(403);
      const refused = JSON.parse(res.body!) as { ok: boolean; reason: string };
      expect(refused.ok).toBe(false);
      expect(refused.reason).toMatch(/insufficient scope/);
      // The decision did NOT happen — the agent is still blocked on a human.
      expect(gw.pendingApprovals().map((a: { id: string }) => a.id)).toContain(id);
      gw.close();
    });
  }

  // The allowlist must admit the whole existing device-role vocabulary: ''
  // (legacy/bootstrap), 'owner' and 'node' (what a companion node signs — see
  // phase22/25/27/29) and 'approver'. Missing one here is a functional
  // regression that locks a real device out of approving, which is why the
  // positive case is pinned alongside the refusals.
  test('every recognised role still resolves — the allowlist is not a blanket denial', async () => {
    for (const role of ['', 'owner', 'node', 'approver']) {
      const cfg = tmpDir('p30-role-allow');
      const { PairingStore, ChallengeRegistry } = await loadDeviceAuth();
      const store = new PairingStore(cfg);
      const deviceId = `sha256:ok-${role || 'legacy'}`;
      const { requestId } = store.requestPairing({ deviceId, role, scopes: [] });
      const { token } = store.approve(requestId, {});
      const { createGateway } = await loadGateway();
      const gw = createGateway({ configDir: cfg, challengeRegistry: new ChallengeRegistry() });
      const { id } = gw.requestApproval({ tool: 'bash', agentId: 'dev', summary: 'ls' });
      const res = mockRes();
      await gw.handle(mkReq('POST', '/gateway/exec/resolve', token, deviceId), res, {
        readBody: async () => JSON.stringify({ id, decision: 'approve' }),
      });
      expect(res.status, `role ${JSON.stringify(role)} must still be able to resolve`).toBe(200);
      expect(gw.pendingApprovals()).toEqual([]);
      gw.close();
    }
  });

  // ── Final round, IMPORTANT — /gateway/connect used to answer
  // `200 {ok:true, token}` with an ALREADY-EXPIRED token: isApproved() only
  // tests that a token string exists, while verifyToken() enforces expiresAt.
  // So the route handed back the same dead token the caller already had, every
  // authenticated call 401'd, and web/ui/pairing.mjs's "pair it again to mint a
  // new device token" advice was impossible to follow — pairing again runs this
  // exact handshake. Reachable in production via `pompos nodes rotate <id>
  // --ttl <ms>`. ─────────────────────────────────────────────────────────
  test('a lapsed device token is re-minted by the handshake, not handed back dead', async () => {
    const cfg = tmpDir('p30-expired-remint');
    const da = await loadDeviceAuth();
    const { PairingStore, ChallengeRegistry } = da;
    const t0 = Date.now();
    const keys = crypto.generateKeyPairSync('ed25519');
    const challengeRegistry = new ChallengeRegistry();
    const { nonce } = challengeRegistry.create();
    const { deviceId, body } = signedConnect(da, keys, nonce, '', [], t0);

    // Approved with a TTL that has already lapsed by t0.
    const store = new PairingStore(cfg);
    const { requestId } = store.requestPairing({ deviceId, role: '', scopes: [] });
    const { token: dead } = store.approve(requestId, { ttlMs: 1000, nowMs: t0 - 60_000 });
    expect(new PairingStore(cfg).verifyToken(deviceId, dead, t0)).toBe(false);

    const { createGateway } = await loadGateway();
    const gw = createGateway({ configDir: cfg, challengeRegistry, nowFn: () => t0 });
    const res = mockRes();
    await gw.handle(connectReq(), res, { readBody: async () => body });

    expect(res.status).toBe(200);
    const minted = (JSON.parse(res.body!) as { ok: boolean; token: string });
    expect(minted.ok).toBe(true);
    expect(minted.token).not.toBe(dead);
    const after = new PairingStore(cfg);
    expect(after.verifyToken(deviceId, minted.token, t0)).toBe(true);
    expect(after.verifyToken(deviceId, dead, t0)).toBe(false);
    gw.close();
  });

  test('a live device token is returned unchanged — the re-mint only fires on a lapse', async () => {
    const cfg = tmpDir('p30-live-keeps-token');
    const da = await loadDeviceAuth();
    const { PairingStore, ChallengeRegistry } = da;
    const t0 = Date.now();
    const keys = crypto.generateKeyPairSync('ed25519');
    const challengeRegistry = new ChallengeRegistry();
    const { nonce } = challengeRegistry.create();
    const { deviceId, body } = signedConnect(da, keys, nonce, '', [], t0);

    const store = new PairingStore(cfg);
    const { requestId } = store.requestPairing({ deviceId, role: '', scopes: [] });
    const { token: live } = store.approve(requestId, { ttlMs: 60_000, nowMs: t0 });

    const { createGateway } = await loadGateway();
    const gw = createGateway({ configDir: cfg, challengeRegistry, nowFn: () => t0 });
    const res = mockRes();
    await gw.handle(connectReq(), res, { readBody: async () => body });

    expect(res.status).toBe(200);
    expect((JSON.parse(res.body!) as { token: string }).token).toBe(live);
    expect(new PairingStore(cfg).deviceInfo(deviceId)?.expiresAt).toBe(t0 + 60_000);
    gw.close();
  });

  // ── Final round, IMPORTANT — the phase's headline security claim, asserted
  // SERVER-side: a dashboard bearer token without a device token resolves
  // nothing. The client-side test (tests/f-pairing-client.test.mjs) only proves
  // the browser does not SEND such a request; this proves the server refuses one
  // that is sent by hand (curl) or by a future client bug. ─────────────────
  test('no header shape but a real device token can resolve an approval', async () => {
    const cfg = tmpDir('p30-resolve-headers');
    const { PairingStore, ChallengeRegistry } = await loadDeviceAuth();
    const store = new PairingStore(cfg);
    const deviceId = 'sha256:hdr';
    const { requestId } = store.requestPairing({ deviceId, role: '', scopes: [] });
    const { token } = store.approve(requestId, {});

    const { createGateway } = await loadGateway();
    const gw = createGateway({ configDir: cfg, challengeRegistry: new ChallengeRegistry() });
    const { id } = gw.requestApproval({ tool: 'bash', agentId: 'dev', summary: 'rm -rf /tmp/x' });

    const shapes: Array<[string, Record<string, string>]> = [
      ['no headers at all', {}],
      ['a dashboard bearer token with no x-device-id', { authorization: 'Bearer dashboard-auth-token' }],
      ['an x-device-id with no bearer token', { 'x-device-id': deviceId }],
      ['a wrong bearer token with the right device id', { authorization: 'Bearer dashboard-auth-token', 'x-device-id': deviceId }],
    ];
    for (const [label, headers] of shapes) {
      const res = mockRes();
      await gw.handle({ method: 'POST', url: '/gateway/exec/resolve', headers, once() { /* no-op */ } }, res, {
        readBody: async () => JSON.stringify({ id, decision: 'approve' }),
      });
      expect(res.status, `${label} must be refused`).toBe(401);
      expect(JSON.parse(res.body!).reason).toBe('invalid device token');
      expect(gw.pendingApprovals().map((a: { id: string }) => a.id), `${label} must leave the approval pending`).toContain(id);
    }

    // Control: the SAME body with the device's real token does resolve, so the
    // four refusals above are about the credentials, not a broken request.
    const ok = mockRes();
    await gw.handle(mkReq('POST', '/gateway/exec/resolve', token, deviceId), ok, {
      readBody: async () => JSON.stringify({ id, decision: 'approve' }),
    });
    expect(ok.status).toBe(200);
    expect(gw.pendingApprovals()).toEqual([]);
    gw.close();
  });
});
