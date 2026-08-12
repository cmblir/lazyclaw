// tests/f-devices-pair.test.mjs — POST /devices/pair and the bootstrap rule.
//
// The rule under test: loopback auto-approve ONLY while no device is paired
// at all. Without the "only while none" clause the non-extractable browser key
// would be pointless — an attacker holding the bearer token could not steal
// the paired device's identity, but could mint a fresh approver of their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { PairingStore, deviceIdFromPublicKey, devicesPath, ChallengeRegistry, buildSignPayload } from '../gateway/device_auth.mjs';
import { devicesPair } from '../daemon/routes/devices_pair.mjs';
import { createGateway } from '../gateway/http_gateway.mjs';

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-pair-'));
  return d;
}

function freshKey() {
  const { publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { der, base64: der.toString('base64'), deviceId: deviceIdFromPublicKey(der) };
}

// Minimal req/res stand-ins. `remoteAddress` is the ONLY loopback signal the
// route may read — a header would be attacker-controlled.
function fakeReq(body, remoteAddress = '127.0.0.1') {
  const raw = JSON.stringify(body);
  return {
    method: 'POST',
    url: '/devices/pair',
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() { yield Buffer.from(raw); },
    // readJson (daemon/lib/respond.mjs) calls req.setEncoding('utf8') before
    // wiring 'data'/'end' — a real http.IncomingMessage has this (it's a
    // Readable stream); this stand-in needs the no-op so readJson doesn't
    // throw "req.setEncoding is not a function" on every call.
    setEncoding() { return this; },
    on(ev, fn) {
      if (ev === 'data') fn(Buffer.from(raw));
      if (ev === 'end') fn();
      return this;
    },
  };
}

function fakeRes() {
  return {
    statusCode: 0, body: null, headers: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; return this; },
    end(payload) { this.body = payload ? JSON.parse(payload) : null; return this; },
  };
}

async function call(gwConfigDir, body, remoteAddress) {
  const req = fakeReq(body, remoteAddress);
  const res = fakeRes();
  await devicesPair({ req, res, gwConfigDir });
  return res;
}

test('the FIRST device on loopback is approved with no operator action', async () => {
  const dir = tmpDir();
  const k = freshKey();
  const res = await call(dir, { publicKey: k.base64, platform: 'browser', label: 'dashboard' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, status: 'approved', deviceId: k.deviceId });
  assert.equal(new PairingStore(dir).isApproved(k.deviceId), true);
});

test('the SECOND device on loopback is pending — the bootstrap slot is used once', async () => {
  const dir = tmpDir();
  const first = freshKey();
  const second = freshKey();
  await call(dir, { publicKey: first.base64, platform: 'browser', label: 'one' });
  const res = await call(dir, { publicKey: second.base64, platform: 'browser', label: 'two' });
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.deviceId, second.deviceId);
  assert.match(res.body.requestId, /.+/);
  assert.equal(res.body.fingerprint, second.deviceId.slice(7, 19));
  const store = new PairingStore(dir);
  assert.equal(store.isApproved(second.deviceId), false);
  assert.equal(store.isApproved(first.deviceId), true, 'approving nobody must not un-approve the device that is already paired');
});

test('a NON-loopback first device is pending — loopback is the whole bootstrap condition', async () => {
  const dir = tmpDir();
  const k = freshKey();
  const res = await call(dir, { publicKey: k.base64, platform: 'browser', label: 'lan' }, '192.168.1.24');
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.status, 'pending');
  assert.equal(new PairingStore(dir).isApproved(k.deviceId), false);
});

test('a forwarded-for header cannot forge loopback', async () => {
  const dir = tmpDir();
  const k = freshKey();
  const req = fakeReq({ publicKey: k.base64 }, '192.168.1.24');
  req.headers['x-forwarded-for'] = '127.0.0.1';
  req.headers['x-real-ip'] = '127.0.0.1';
  const res = fakeRes();
  await devicesPair({ req, res, gwConfigDir: dir });
  assert.equal(res.statusCode, 202, 'the socket address is the only trustworthy signal');
  assert.equal(new PairingStore(dir).isApproved(k.deviceId), false);
});

for (const remote of ['::1', '::ffff:127.0.0.1']) {
  test(`IPv6 loopback ${remote} counts as loopback`, async () => {
    const dir = tmpDir();
    const k = freshKey();
    const res = await call(dir, { publicKey: k.base64 }, remote);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'approved');
  });
}

test('re-pairing an already-approved device is idempotent and mints no second request', async () => {
  const dir = tmpDir();
  const k = freshKey();
  await call(dir, { publicKey: k.base64 });
  const res = await call(dir, { publicKey: k.base64 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'approved');
  assert.equal(new PairingStore(dir).pending().length, 0);
});

test('a repeated pending request reuses its requestId', async () => {
  const dir = tmpDir();
  await call(dir, { publicKey: freshKey().base64 });          // consume the bootstrap slot
  const k = freshKey();
  const a = await call(dir, { publicKey: k.base64 });
  const b = await call(dir, { publicKey: k.base64 });
  assert.equal(a.body.requestId, b.body.requestId, 'a reload must not pile up duplicate pending requests');
  assert.equal(new PairingStore(dir).pending().length, 1);
});

test('a malformed public key is a named 400, not a 500', async () => {
  const dir = tmpDir();
  const res = await call(dir, { publicKey: 'not-a-key' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'BAD_PUBLIC_KEY');
  assert.equal(res.body.ok, false);
});

test('a missing public key is a named 400', async () => {
  const dir = tmpDir();
  const res = await call(dir, { platform: 'browser' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'BAD_BODY');
});

test('two concurrent first-pair requests approve EXACTLY ONE device', async () => {
  const dir = tmpDir();
  const a = freshKey();
  const b = freshKey();
  const [ra, rb] = await Promise.all([
    call(dir, { publicKey: a.base64, label: 'a' }),
    call(dir, { publicKey: b.base64, label: 'b' }),
  ]);
  const statuses = [ra.body.status, rb.body.status].sort();
  assert.deepEqual(statuses, ['approved', 'pending'],
    'both browsers seeing an empty roster and both auto-approving would mint two approvers from one bootstrap slot');
  assert.equal(new PairingStore(dir).devicesList().length, 1,
    'and the loser must still be on disk as a pending request, not have overwritten the winner');
});

// ── Fix round 1 — a key type /gateway/connect can never authenticate must
// never burn the one-shot bootstrap slot (Important 1) ──────────────────

test('an RSA-2048 public key is a named 400, not an approved device', async () => {
  const dir = tmpDir();
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const base64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const res = await call(dir, { publicKey: base64 });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'BAD_PUBLIC_KEY');
  assert.equal(new PairingStore(dir).devicesList().length, 0,
    'an unauthenticatable key must not spend the bootstrap slot');
});

test('a P-256 (EC) public key is a named 400, not an approved device', async () => {
  const dir = tmpDir();
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const base64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const res = await call(dir, { publicKey: base64 });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'BAD_PUBLIC_KEY');
  assert.equal(new PairingStore(dir).devicesList().length, 0);
});

test('an Ed25519 PRIVATE key PEM is rejected, not silently reduced to its public half', async () => {
  const dir = tmpDir();
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const res = await call(dir, { publicKey: pem });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'BAD_PUBLIC_KEY');
  assert.equal(new PairingStore(dir).devicesList().length, 0);
});

// ── Fix round 1 — Minor 6: unsigned label/platform are capped ───────────

test('an oversized label/platform is truncated to 64 chars before it is persisted', async () => {
  const dir = tmpDir();
  const k = freshKey();
  const longLabel = 'MacBook Pro — kitchen '.repeat(10);
  await call(dir, { publicKey: freshKey().base64 }); // consume the bootstrap slot
  await call(dir, { publicKey: k.base64, label: longLabel, platform: 'x'.repeat(500) });
  const req = new PairingStore(dir).pending()[0];
  assert.ok(req.label.length <= 64, `label must be capped, got ${req.label.length} chars`);
  assert.ok(req.platform.length <= 64, `platform must be capped, got ${req.platform.length} chars`);
});

// ── Fix round 1 — Minor 7: previously-untested envelopes ─────────────────

test('the pending-requests ceiling answers a named 429, not a 500', async () => {
  const dir = tmpDir();
  // Pre-fill devices.json to the cap directly (1000 synchronous
  // requestPairing() calls would be needlessly slow for the same effect).
  const requests = {};
  for (let i = 0; i < 1000; i++) {
    const id = `pr_fill${i}`;
    requests[id] = {
      requestId: id, deviceId: `sha256:fill${i}`, platform: '', label: '',
      role: '', scopes: [], status: 'pending', createdAt: new Date().toISOString(),
    };
  }
  const p = devicesPath(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ version: 1, requests, devices: {} }));

  const res = await call(dir, { publicKey: freshKey().base64 });
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'PAIRING_CAP');
});

test('fail-closed: a request with no socket at all is never auto-approved', async () => {
  const dir = tmpDir();
  const k = freshKey();
  const req = fakeReq({ publicKey: k.base64 });
  delete req.socket;
  const res = fakeRes();
  await devicesPair({ req, res, gwConfigDir: dir });
  assert.equal(res.statusCode, 202);
  assert.equal(new PairingStore(dir).isApproved(k.deviceId), false);
});

test('fail-closed: a request with an empty socket object is never auto-approved', async () => {
  const dir = tmpDir();
  const k = freshKey();
  const req = fakeReq({ publicKey: k.base64 });
  req.socket = {};
  const res = fakeRes();
  await devicesPair({ req, res, gwConfigDir: dir });
  assert.equal(res.statusCode, 202);
  assert.equal(new PairingStore(dir).isApproved(k.deviceId), false);
});

// ── Fix round 2 — Minor: the reentrancy/unexpected-throw envelope IS
// reachable through the public interface, with no source edit and no
// production hook: a non-writable config dir makes PairingStore._persist()
// raise a real EACCES inside the critical section. ────────────────────────

test('an EACCES inside the critical section answers a named 500 PAIR_BUSY, no path leaked', async (t) => {
  // Directory mode bits don't restrict root, so this test is meaningless
  // (and would hang or misbehave) when run as root.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('running as root — directory permission bits do not apply');
    return;
  }
  const dir = tmpDir();
  // No write bit: PairingStore._persist() -> writeAtomic() cannot
  // fs.mkdirSync() the not-yet-existing gateway/ subdirectory under it.
  fs.chmodSync(dir, 0o500);
  try {
    const k = freshKey();
    const res = await call(dir, { publicKey: k.base64 });
    assert.equal(res.statusCode, 500);
    // Exact-shape check (not just the code): proves nothing extra — in
    // particular no absolute filesystem path from the underlying EACCES
    // message — rides along in the response.
    assert.deepEqual(res.body, {
      ok: false,
      error: 'pairing request could not be completed',
      code: 'PAIR_BUSY',
    });
  } finally {
    // Restore before the directory is left behind for OS tmp cleanup, so a
    // failed assertion above can't leave a locked directory around.
    fs.chmodSync(dir, 0o700);
  }
});

// ── Final round, IMPORTANT — the bootstrap slot must be ONE-SHOT ─────────
// The condition was `store.devicesList().length === 0`, and revoke() DELETES
// the device record — so the slot reopened every time the roster went empty,
// and the Devices panel's own copy walks the operator straight into it
// ("Revoke the old record with `pompos nodes revoke`" after forgetting this
// browser's key). Whichever loopback process reached /devices/pair first then
// became the sole approver, and it need not be the browser. The marker is now
// an approved REQUEST row, which revoke() never touches.

test('the bootstrap slot does NOT reopen after the only device is revoked', async () => {
  const dir = tmpDir();
  const first = freshKey();
  const other = freshKey();
  assert.equal((await call(dir, { publicKey: first.base64 })).statusCode, 200);

  new PairingStore(dir).revoke(first.deviceId);
  assert.equal(new PairingStore(dir).devicesList().length, 0,
    'the roster is empty again — this is exactly the pre-fix trigger');

  const res = await call(dir, { publicKey: other.base64, label: 'not the browser' });
  assert.equal(res.statusCode, 202,
    'a different key on loopback must be pending, not the install\'s new sole approver');
  assert.equal(res.body.status, 'pending');
  assert.equal(new PairingStore(dir).isApproved(other.deviceId), false);
  assert.equal(new PairingStore(dir).devicesList().length, 0);
});

test('the approved-request marker outlives the pending-request prune it shares a table with', async () => {
  // The whole one-shot fix rests on an approved row being durable, so pin it:
  // _prunePending() ages out rows whose status is still 'pending' only.
  const dir = tmpDir();
  const first = freshKey();
  await call(dir, { publicKey: first.base64 });

  // Backdate every row past the 24h pending TTL, then trigger a prune (any
  // requestPairing call runs one) via a second, unrelated pairing attempt.
  const p = devicesPath(dir);
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const r of Object.values(data.requests)) r.createdAt = '2000-01-01T00:00:00.000Z';
  fs.writeFileSync(p, JSON.stringify(data));

  const res = await call(dir, { publicKey: freshKey().base64 });
  assert.equal(res.statusCode, 202, 'the approved marker must survive the prune and keep the slot shut');
  const survived = Object.values(new PairingStore(dir)._data.requests).filter((r) => r.status === 'approved');
  assert.equal(survived.length, 1, 'an approved request row is the roster, not the abuse surface');
});
