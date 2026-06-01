import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lc-${prefix}-`));
}

async function loadAuth() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'gateway', 'device_auth.mjs')).href;
  return await import(url) as typeof import('../gateway/device_auth.mjs');
}

// A reusable Ed25519 keypair for the signature tests.
function genKeyPair() {
  return crypto.generateKeyPairSync('ed25519');
}

test.describe('Phase 22 — WS gateway device auth (pure logic)', () => {
  test('deviceIdFromPublicKey is deterministic and is a sha256 hex of the DER SPKI', async () => {
    const mod = await loadAuth();
    const { publicKey } = genKeyPair();

    const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const expected = 'sha256:' + crypto.createHash('sha256').update(der).digest('hex');

    // Same key → same id regardless of PEM vs DER input.
    expect(mod.deviceIdFromPublicKey(pem)).toBe(expected);
    expect(mod.deviceIdFromPublicKey(der)).toBe(expected);
    expect(mod.deviceIdFromPublicKey(pem)).toBe(mod.deviceIdFromPublicKey(der));

    // Shape: sha256:<64 hex chars>
    expect(mod.deviceIdFromPublicKey(pem)).toMatch(/^sha256:[0-9a-f]{64}$/);

    // A different key → a different id.
    const { publicKey: other } = genKeyPair();
    expect(mod.deviceIdFromPublicKey(other.export({ type: 'spki', format: 'pem' }) as string))
      .not.toBe(expected);
  });

  test('createChallenge mints a fresh 32-byte hex nonce and a current epoch-ms ts', async () => {
    const mod = await loadAuth();
    const before = Date.now();
    const c1 = mod.createChallenge();
    const after = Date.now();

    expect(c1.nonce).toMatch(/^[0-9a-f]{64}$/); // 32 bytes → 64 hex chars
    expect(typeof c1.ts).toBe('number');
    expect(c1.ts).toBeGreaterThanOrEqual(before);
    expect(c1.ts).toBeLessThanOrEqual(after);

    // Nonces must not repeat.
    const c2 = mod.createChallenge();
    expect(c2.nonce).not.toBe(c1.nonce);
  });

  test('buildSignPayload produces a stable canonical v3 string', async () => {
    const mod = await loadAuth();
    const fields = {
      deviceId: 'sha256:abc',
      clientId: 'client-1',
      clientMode: 'control',
      role: 'owner',
      scopes: ['read', 'write'],
      signedAtMs: 1717200000000,
      token: 'tok-xyz',
      nonce: 'deadbeef',
      platform: 'ios',
      deviceFamily: 'phone',
    };
    const payload = mod.buildSignPayload(fields);
    expect(payload.startsWith('v3|')).toBe(true);
    // Deterministic: same input → identical bytes.
    expect(mod.buildSignPayload(fields)).toBe(payload);
    // Every field is represented in the canonical string.
    expect(payload).toContain('sha256:abc');
    expect(payload).toContain('client-1');
    expect(payload).toContain('deadbeef');
    expect(payload).toContain('1717200000000');
    // Changing one field changes the payload.
    expect(mod.buildSignPayload({ ...fields, nonce: 'feedface' })).not.toBe(payload);
  });

  test('verifyConnect accepts a correctly-signed payload bound to the challenge', async () => {
    const mod = await loadAuth();
    const { publicKey, privateKey } = genKeyPair();
    const challenge = mod.createChallenge();
    const nowMs = challenge.ts + 1000;

    const payload = mod.buildSignPayload({
      deviceId: mod.deviceIdFromPublicKey(publicKey.export({ type: 'spki', format: 'der' }) as Buffer),
      clientId: 'client-1',
      clientMode: 'control',
      role: 'owner',
      scopes: ['read'],
      signedAtMs: nowMs,
      token: 'tok',
      nonce: challenge.nonce,
      platform: 'ios',
      deviceFamily: 'phone',
    });
    const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');

    const res = mod.verifyConnect({ payload, signature, publicKey, challenge, nowMs });
    expect(res.ok).toBe(true);
  });

  test('verifyConnect rejects a tampered payload', async () => {
    const mod = await loadAuth();
    const { publicKey, privateKey } = genKeyPair();
    const challenge = mod.createChallenge();
    const nowMs = challenge.ts;

    const payload = mod.buildSignPayload({
      deviceId: 'sha256:abc', clientId: 'c', clientMode: 'control', role: 'owner',
      scopes: ['read'], signedAtMs: nowMs, token: 't', nonce: challenge.nonce,
      platform: 'ios', deviceFamily: 'phone',
    });
    const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');

    // Flip a byte in the signed payload — signature no longer matches.
    const tampered = payload.replace('owner', 'admin');
    const res = mod.verifyConnect({ payload: tampered, signature, publicKey, challenge, nowMs });
    expect(res.ok).toBe(false);
    expect(res.reason).toBeTruthy();
  });

  test('verifyConnect rejects a payload whose nonce does not match the challenge', async () => {
    const mod = await loadAuth();
    const { publicKey, privateKey } = genKeyPair();
    const challenge = mod.createChallenge();
    const nowMs = challenge.ts;

    // Use the deviceId actually derived from this key so the identity-binding
    // gate passes and the nonce gate is what does the rejecting.
    const deviceId = mod.deviceIdFromPublicKey(
      publicKey.export({ type: 'spki', format: 'der' }) as Buffer,
    );
    // Sign a payload carrying a DIFFERENT nonce than the live challenge.
    const payload = mod.buildSignPayload({
      deviceId, clientId: 'c', clientMode: 'control', role: 'owner',
      scopes: ['read'], signedAtMs: nowMs, token: 't',
      nonce: '00'.repeat(32), platform: 'ios', deviceFamily: 'phone',
    });
    const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');

    const res = mod.verifyConnect({ payload, signature, publicKey, challenge, nowMs });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/nonce/i);
  });

  test('verifyConnect rejects a stale signedAtMs outside the skew window', async () => {
    const mod = await loadAuth();
    const { publicKey, privateKey } = genKeyPair();
    const challenge = mod.createChallenge();
    const signedAtMs = challenge.ts;

    // Derive the correct deviceId so the identity-binding gate passes and the
    // skew gate is what does the rejecting.
    const deviceId = mod.deviceIdFromPublicKey(
      publicKey.export({ type: 'spki', format: 'der' }) as Buffer,
    );
    const payload = mod.buildSignPayload({
      deviceId, clientId: 'c', clientMode: 'control', role: 'owner',
      scopes: ['read'], signedAtMs, token: 't', nonce: challenge.nonce,
      platform: 'ios', deviceFamily: 'phone',
    });
    const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');

    // Validly-signed, correct nonce, but the clock has moved well past the
    // default 120 s skew window.
    const nowMs = signedAtMs + 200_000;
    const res = mod.verifyConnect({ payload, signature, publicKey, challenge, nowMs });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/skew|stale|expire/i);

    // A signature from the future, beyond skew, is rejected too.
    const future = mod.verifyConnect({ payload, signature, publicKey, challenge, nowMs: signedAtMs - 200_000 });
    expect(future.ok).toBe(false);

    // Within the window it still passes.
    const fresh = mod.verifyConnect({ payload, signature, publicKey, challenge, nowMs: signedAtMs + 5_000 });
    expect(fresh.ok).toBe(true);
  });

  test('PairingStore: requestPairing returns a pending request and never a token', async () => {
    const mod = await loadAuth();
    const cfg = tmpDir('p22-pair');
    const store = new mod.PairingStore(cfg);

    const req = store.requestPairing({ deviceId: 'sha256:dev1', platform: 'ios', label: 'My iPhone' });
    expect(req.status).toBe('pending');
    expect(typeof req.requestId).toBe('string');
    expect(req.requestId.length).toBeGreaterThan(0);
    // A pairing request must NEVER leak a token.
    expect((req as Record<string, unknown>).token).toBeUndefined();
    expect(JSON.stringify(req)).not.toMatch(/token/i);

    // Unknown / not-yet-approved device has no token and is not approved.
    expect(store.isApproved('sha256:dev1')).toBe(false);
    expect(store.tokenFor('sha256:dev1')).toBeNull();
  });

  test('PairingStore: a brand-new deviceId has no token until approve() is called', async () => {
    const mod = await loadAuth();
    const cfg = tmpDir('p22-newdev');
    const store = new mod.PairingStore(cfg);

    // Never requested, never approved.
    expect(store.isApproved('sha256:unknown')).toBe(false);
    expect(store.tokenFor('sha256:unknown')).toBeNull();
  });

  test('PairingStore: approve() issues a token and re-approve rotates it', async () => {
    const mod = await loadAuth();
    const cfg = tmpDir('p22-approve');
    const store = new mod.PairingStore(cfg);

    const req = store.requestPairing({ deviceId: 'sha256:dev2', platform: 'android', label: 'Pixel' });
    const approved = store.approve(req.requestId);
    expect(approved.deviceId).toBe('sha256:dev2');
    expect(approved.token).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex

    expect(store.isApproved('sha256:dev2')).toBe(true);
    expect(store.tokenFor('sha256:dev2')).toBe(approved.token);

    // Re-approve (re-pair) the SAME device → token must change.
    const req2 = store.requestPairing({ deviceId: 'sha256:dev2', platform: 'android', label: 'Pixel' });
    const reapproved = store.approve(req2.requestId);
    expect(reapproved.deviceId).toBe('sha256:dev2');
    expect(reapproved.token).toMatch(/^[0-9a-f]{64}$/);
    expect(reapproved.token).not.toBe(approved.token); // rotated
    expect(store.tokenFor('sha256:dev2')).toBe(reapproved.token);
  });

  test('PairingStore: revoke() drops approval and the token; survives reload from disk', async () => {
    const mod = await loadAuth();
    const cfg = tmpDir('p22-revoke');
    const store = new mod.PairingStore(cfg);

    const req = store.requestPairing({ deviceId: 'sha256:dev3', platform: 'ios', label: 'iPad' });
    const approved = store.approve(req.requestId);
    expect(store.tokenFor('sha256:dev3')).toBe(approved.token);

    // A fresh store reading the same configDir sees the persisted approval.
    const reloaded = new mod.PairingStore(cfg);
    expect(reloaded.isApproved('sha256:dev3')).toBe(true);
    expect(reloaded.tokenFor('sha256:dev3')).toBe(approved.token);

    reloaded.revoke('sha256:dev3');
    expect(reloaded.isApproved('sha256:dev3')).toBe(false);
    expect(reloaded.tokenFor('sha256:dev3')).toBeNull();

    // And the revocation persists.
    const reloaded2 = new mod.PairingStore(cfg);
    expect(reloaded2.isApproved('sha256:dev3')).toBe(false);
  });

  test('PairingStore: persists devices.json under <configDir>/gateway', async () => {
    const mod = await loadAuth();
    const cfg = tmpDir('p22-path');
    const store = new mod.PairingStore(cfg);
    const req = store.requestPairing({ deviceId: 'sha256:dev4', platform: 'ios', label: 'x' });
    store.approve(req.requestId);

    const expected = path.join(cfg, 'gateway', 'devices.json');
    expect(fs.existsSync(expected)).toBe(true);
    const json = JSON.parse(fs.readFileSync(expected, 'utf8'));
    // The on-disk record must carry the device but the test only asserts
    // the file exists and parses — the token shape is covered elsewhere.
    expect(json).toBeTruthy();
  });

  // --- Phase 22 hardening: negative tests for the confirmed findings ---

  // Finding 1 (CRITICAL): the supplied publicKey must be bound to the
  // payload's deviceId. An attacker who signs a payload that CLAIMS the
  // victim's deviceId, but presents their OWN keypair, must be rejected —
  // otherwise verifyConnect would let anyone impersonate any device.
  test('verifyConnect rejects an impersonation: payload deviceId not derived from publicKey', async () => {
    const mod = await loadAuth();
    const attacker = genKeyPair();
    const victim = genKeyPair();

    const victimDeviceId = mod.deviceIdFromPublicKey(
      victim.publicKey.export({ type: 'spki', format: 'der' }) as Buffer,
    );

    const challenge = mod.createChallenge();
    const nowMs = challenge.ts + 1000;

    // The attacker forges a payload claiming the VICTIM's deviceId, then signs
    // it with their OWN private key and presents their OWN public key. The
    // signature is perfectly valid for the attacker's key — only the deviceId
    // binding can catch this.
    const payload = mod.buildSignPayload({
      deviceId: victimDeviceId,
      clientId: 'client-evil',
      clientMode: 'control',
      role: 'owner',
      scopes: ['read'],
      signedAtMs: nowMs,
      token: 'tok',
      nonce: challenge.nonce,
      platform: 'ios',
      deviceFamily: 'phone',
    });
    const signature = crypto.sign(null, Buffer.from(payload), attacker.privateKey).toString('base64');

    const res = mod.verifyConnect({
      payload, signature, publicKey: attacker.publicKey, challenge, nowMs,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/device id mismatch/i);
  });

  test('verifyConnect accepts when the payload deviceId IS derived from the publicKey', async () => {
    const mod = await loadAuth();
    const { publicKey, privateKey } = genKeyPair();
    const challenge = mod.createChallenge();
    const nowMs = challenge.ts + 1000;

    const deviceId = mod.deviceIdFromPublicKey(
      publicKey.export({ type: 'spki', format: 'der' }) as Buffer,
    );
    const payload = mod.buildSignPayload({
      deviceId, clientId: 'c', clientMode: 'control', role: 'owner',
      scopes: ['read'], signedAtMs: nowMs, token: 'tok', nonce: challenge.nonce,
      platform: 'ios', deviceFamily: 'phone',
    });
    const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');

    const res = mod.verifyConnect({ payload, signature, publicKey, challenge, nowMs });
    expect(res.ok).toBe(true);
  });

  // Finding 2 (HIGH): nonce replay + challenge expiry, enforced by a
  // single-use ChallengeRegistry.
  test('ChallengeRegistry.consume() is single-use: the second consume of the same nonce fails', async () => {
    const mod = await loadAuth();
    const registry = new mod.ChallengeRegistry();

    const challenge = registry.create();
    expect(challenge.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof challenge.ts).toBe('number');

    const nowMs = challenge.ts + 1000;
    // First consume within the window succeeds.
    expect(registry.consume(challenge.nonce, nowMs)).toBe(true);
    // Replay: the very same nonce must NOT verify a second time.
    expect(registry.consume(challenge.nonce, nowMs)).toBe(false);
  });

  test('ChallengeRegistry.consume() rejects an expired challenge (older than maxSkewMs)', async () => {
    const mod = await loadAuth();
    const registry = new mod.ChallengeRegistry({ maxSkewMs: 120_000 });

    const challenge = registry.create();
    // Age the challenge well past the skew window before consuming it.
    const tooLate = challenge.ts + 200_000;
    expect(registry.consume(challenge.nonce, tooLate)).toBe(false);

    // An unknown nonce is likewise rejected.
    expect(registry.consume('ff'.repeat(32), challenge.ts + 1)).toBe(false);
  });

  test('ChallengeRegistry.consume() accepts a fresh, never-used challenge within the window', async () => {
    const mod = await loadAuth();
    const registry = new mod.ChallengeRegistry({ maxSkewMs: 120_000 });
    const challenge = registry.create();
    expect(registry.consume(challenge.nonce, challenge.ts + 5_000)).toBe(true);
  });

  // Finding 3 (MEDIUM): approve() must guard on status. Re-approving an
  // already-approved request must NOT mint/rotate a fresh token.
  test('PairingStore: approve() twice on the SAME request throws (no silent token rotation)', async () => {
    const mod = await loadAuth();
    const cfg = tmpDir('p22-approve-twice');
    const store = new mod.PairingStore(cfg);

    const req = store.requestPairing({ deviceId: 'sha256:dev5', platform: 'ios', label: 'x' });
    const first = store.approve(req.requestId);
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);

    // Re-approving the same (now non-pending) request must throw, and the
    // device token must be unchanged afterwards.
    expect(() => store.approve(req.requestId)).toThrow(/request not pending/i);
    expect(store.tokenFor('sha256:dev5')).toBe(first.token);
  });

  // Finding 4 (MEDIUM): devices.json holds plaintext bearer tokens, so it
  // must not be world/group readable, and neither must its parent dir.
  test('PairingStore: devices.json and its gateway dir are owner-only (0600 / 0700)', async () => {
    const mod = await loadAuth();
    const cfg = tmpDir('p22-perms');
    const store = new mod.PairingStore(cfg);
    const req = store.requestPairing({ deviceId: 'sha256:dev6', platform: 'ios', label: 'x' });
    store.approve(req.requestId);

    const filePath = path.join(cfg, 'gateway', 'devices.json');
    const dirPath = path.join(cfg, 'gateway');
    const fileMode = fs.statSync(filePath).mode & 0o777;
    const dirMode = fs.statSync(dirPath).mode & 0o777;

    // No group / other bits — the file carries plaintext tokens.
    expect(fileMode & 0o077).toBe(0);
    expect(fileMode & 0o600).toBe(0o600);
    expect(dirMode & 0o077).toBe(0);
    expect(dirMode & 0o700).toBe(0o700);
  });

  // Finding 5 (LOW): a timing-safe token comparison must be exported.
  test('verifyToken does a timing-safe compare and rejects wrong / length-mismatched tokens', async () => {
    const mod = await loadAuth();
    const cfg = tmpDir('p22-verifytoken');
    const store = new mod.PairingStore(cfg);
    const req = store.requestPairing({ deviceId: 'sha256:dev7', platform: 'ios', label: 'x' });
    const approved = store.approve(req.requestId);

    // Correct token verifies.
    expect(store.verifyToken('sha256:dev7', approved.token)).toBe(true);
    // Wrong token of equal length is rejected.
    const wrongSameLen = 'a'.repeat(approved.token.length);
    expect(store.verifyToken('sha256:dev7', wrongSameLen)).toBe(false);
    // Length mismatch short-circuits to false (no throw).
    expect(store.verifyToken('sha256:dev7', approved.token + 'ff')).toBe(false);
    expect(store.verifyToken('sha256:dev7', '')).toBe(false);
    // Unknown device → false (no token on file).
    expect(store.verifyToken('sha256:nope', approved.token)).toBe(false);
    // Non-string presented token → false, never throws.
    expect(store.verifyToken('sha256:dev7', undefined as unknown as string)).toBe(false);
  });
});
