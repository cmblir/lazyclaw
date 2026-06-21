// tests/f-device-scopes.test.mjs
//
// Roadmap #6b — the signed pairing payload carries role + scopes (read-only vs
// approver), but requestPairing dropped them, so there was no authorization
// surface. They now flow requestPairing → approve → the device record (and
// survive rotate), so the gateway can gate mutating actions on capability.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PairingStore } from '../gateway/device_auth.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaw-scope-'));

test('role + scopes flow from requestPairing through approve to the device record', () => {
  const store = new PairingStore(tmp());
  const { requestId } = store.requestPairing({ deviceId: 'sha256:sc', platform: 'cli', role: 'read-only', scopes: ['exec:read', 'events'] });
  const { deviceId } = store.approve(requestId, {});
  const info = store.deviceInfo(deviceId);
  assert.equal(info.role, 'read-only');
  assert.deepEqual(info.scopes, ['exec:read', 'events']);
});

test('role/scopes default to empty when not supplied (backward compat)', () => {
  const store = new PairingStore(tmp());
  const { requestId } = store.requestPairing({ deviceId: 'sha256:sc2' });
  const { deviceId } = store.approve(requestId, {});
  const info = store.deviceInfo(deviceId);
  assert.equal(info.role, '');
  assert.deepEqual(info.scopes, []);
});

test('rotate preserves role/scopes', () => {
  const store = new PairingStore(tmp());
  const { requestId } = store.requestPairing({ deviceId: 'sha256:sc3', role: 'approver', scopes: ['exec:approve'] });
  const { deviceId } = store.approve(requestId, {});
  store.rotate(deviceId, {});
  const info = store.deviceInfo(deviceId);
  assert.equal(info.role, 'approver');
  assert.deepEqual(info.scopes, ['exec:approve']);
});
