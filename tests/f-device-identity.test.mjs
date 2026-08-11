// tests/f-device-identity.test.mjs — the browser's device keypair.
//
// Runs under node --test against Node's own crypto.subtle (which supports
// Ed25519) with a Map-backed stand-in for IndexedDB, so the protocol-level
// facts are pinned without a browser. The browser-only facts — that
// crypto.subtle exists at all, and that IndexedDB survives a reload — are
// covered by tests/phaseI-dashboard-operations.spec.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { deviceIdFromPublicKey } from '../gateway/device_auth.mjs';
import { getOrCreateIdentity, sign, forgetIdentity, IdentityError } from '../web/ui/device_identity.mjs';

// The smallest thing that satisfies the store contract. A real CryptoKey is
// held by reference, exactly as IndexedDB's structured clone would hold it.
function fakeStore() {
  let held = null;
  return {
    async get() { return held; },
    async put(pair) { held = pair; },
    async del() { held = null; },
    peek() { return held; },
  };
}

function deps(store = fakeStore()) {
  return { subtle: webcrypto.subtle, store };
}

test('the deviceId the browser derives is the one the server derives', async () => {
  const d = deps();
  const { deviceId, publicKeyDerBase64 } = await getOrCreateIdentity(d);
  assert.match(deviceId, /^sha256:[0-9a-f]{64}$/);
  const der = Buffer.from(publicKeyDerBase64, 'base64');
  assert.equal(deviceId, deviceIdFromPublicKey(der),
    'the browser must hash the same DER SPKI bytes the server hashes, or pairing binds the wrong identity');
});

test('a second call reuses the stored key instead of minting a new identity', async () => {
  const d = deps();
  const first = await getOrCreateIdentity(d);
  const second = await getOrCreateIdentity(d);
  assert.equal(second.deviceId, first.deviceId);
  assert.equal(second.publicKeyDerBase64, first.publicKeyDerBase64);
});

test('the stored private key cannot be exported', async () => {
  const store = fakeStore();
  await getOrCreateIdentity(deps(store));
  const { privateKey } = store.peek();
  assert.equal(privateKey.extractable, false);
  await assert.rejects(() => webcrypto.subtle.exportKey('pkcs8', privateKey),
    'a key an attacker can export is a key an attacker can impersonate');
});

test('sign produces a 64-byte signature the public key verifies', async () => {
  const store = fakeStore();
  const d = deps(store);
  await getOrCreateIdentity(d);
  const bytes = new TextEncoder().encode('canonical|payload|string');
  const sig = await sign(bytes, d);
  assert.equal(sig.length, 64);
  const ok = await webcrypto.subtle.verify('Ed25519', store.peek().publicKey, sig, bytes);
  assert.equal(ok, true);
});

test('sign before getOrCreateIdentity fails loudly instead of signing with nothing', async () => {
  const d = deps();
  await assert.rejects(() => sign(new Uint8Array([1]), d), (e) => e instanceof IdentityError && e.code === 'NO_IDENTITY');
});

test('forgetIdentity drops the pair, and the next call mints a different identity', async () => {
  const store = fakeStore();
  const d = deps(store);
  const before = await getOrCreateIdentity(d);
  await forgetIdentity(d);
  assert.equal(store.peek(), null);
  const after = await getOrCreateIdentity(d);
  assert.notEqual(after.deviceId, before.deviceId);
});

test('no WebCrypto reports NO_WEBCRYPTO rather than throwing a TypeError', async () => {
  await assert.rejects(
    () => getOrCreateIdentity({ subtle: undefined, store: fakeStore() }),
    (e) => e instanceof IdentityError && e.code === 'NO_WEBCRYPTO',
    'a dashboard served over plain http on a LAN address has no crypto.subtle at all; the operator must be told why, not shown a stack trace',
  );
});

test('a browser that refuses Ed25519 reports NO_ED25519', async () => {
  const subtle = { generateKey: async () => { throw new DOMException('Unrecognized name.', 'NotSupportedError'); } };
  await assert.rejects(
    () => getOrCreateIdentity({ subtle, store: fakeStore() }),
    (e) => e instanceof IdentityError && e.code === 'NO_ED25519',
  );
});
