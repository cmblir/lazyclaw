// tests/f-device-token-ttl.test.mjs
//
// Roadmap #6b — device tokens never expired: once approve() minted a bearer it
// was valid forever. approve({ttlMs,nowMs}) now stamps an expiresAt and
// verifyToken(deviceId,token,nowMs) rejects an expired token. Backward-compatible:
// a legacy record with no expiresAt never expires, and verifyToken with no nowMs
// keeps the old (TTL-unaware) behaviour. nowMs is injected for deterministic tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PairingStore } from '../gateway/device_auth.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaw-ttl-'));
const approve = (store, deviceId, opts) => {
  const { requestId } = store.requestPairing({ deviceId, platform: 'cli' });
  return store.approve(requestId, opts);
};

test('approve with ttlMs sets expiresAt; verifyToken rejects an expired token', () => {
  const store = new PairingStore(tmp());
  const { deviceId, token } = approve(store, 'sha256:aaa', { ttlMs: 1000, nowMs: 1000 });
  assert.equal(store.verifyToken(deviceId, token, 1500), true, 'valid before expiry');
  assert.equal(store.verifyToken(deviceId, token, 2001), false, 'rejected after expiry');
  assert.equal(store.verifyToken(deviceId, token, 2000), false, 'rejected at the expiry instant (>=)');
});

test('verifyToken without nowMs skips the TTL check (backward compat)', () => {
  const store = new PairingStore(tmp());
  const { deviceId, token } = approve(store, 'sha256:bbb', { ttlMs: 1, nowMs: 0 });
  assert.equal(store.verifyToken(deviceId, token), true, 'no nowMs → no expiry enforcement');
});

test('a record without a ttl (legacy) never expires', () => {
  const store = new PairingStore(tmp());
  const { deviceId, token } = approve(store, 'sha256:ccc'); // no ttl options
  assert.equal(store.verifyToken(deviceId, token, 9_999_999_999), true);
});

test('a wrong/length-mismatched token is rejected regardless of expiry', () => {
  const store = new PairingStore(tmp());
  const { deviceId } = approve(store, 'sha256:ddd', { ttlMs: 1000, nowMs: 0 });
  assert.equal(store.verifyToken(deviceId, 'wrong', 500), false);
  assert.equal(store.verifyToken(deviceId, '', 500), false);
});
