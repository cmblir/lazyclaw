// tests/f-device-token-rotate.test.mjs
//
// Roadmap #6b — rotating a device's token used to require a whole new pairing
// handshake (requestPairing → approve). store.rotate(deviceId) re-issues a
// fresh token in place: the old token stops working, the new one works, and the
// device's non-secret fields (platform/label/role/scopes) are preserved.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PairingStore } from '../gateway/device_auth.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaw-rot-'));
const approve = (store, deviceId, opts) => {
  const { requestId } = store.requestPairing({ deviceId, platform: 'cli', label: 'my-laptop' });
  return store.approve(requestId, opts);
};

test('rotate issues a fresh token; the old one stops authenticating', () => {
  const store = new PairingStore(tmp());
  const { deviceId, token: old } = approve(store, 'sha256:rot', { ttlMs: 1000, nowMs: 0 });
  const { token: fresh, expiresAt } = store.rotate(deviceId, { ttlMs: 5000, nowMs: 1000 });
  assert.notEqual(fresh, old, 'a new token is minted');
  assert.equal(store.verifyToken(deviceId, old, 1500), false, 'old token revoked');
  assert.equal(store.verifyToken(deviceId, fresh, 1500), true, 'new token works');
  assert.equal(expiresAt, 6000, 'fresh expiresAt computed from the rotate ttl');
});

test('rotate preserves the device record metadata', () => {
  const store = new PairingStore(tmp());
  const { deviceId } = approve(store, 'sha256:rot2');
  store.rotate(deviceId, {});
  const info = store.deviceInfo(deviceId);
  assert.equal(info.platform, 'cli');
  assert.equal(info.label, 'my-laptop');
});

test('rotate without a ttl produces a never-expiring token', () => {
  const store = new PairingStore(tmp());
  const { deviceId } = approve(store, 'sha256:rot3', { ttlMs: 10, nowMs: 0 });
  const { token } = store.rotate(deviceId, {}); // no ttl → clears expiry
  assert.equal(store.verifyToken(deviceId, token, 9_999_999_999), true);
});

test('rotate of an unknown/unapproved device throws', () => {
  const store = new PairingStore(tmp());
  assert.throws(() => store.rotate('sha256:ghost', {}), /no approved device|cannot rotate/i);
});
