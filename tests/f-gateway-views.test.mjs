// tests/f-gateway-views.test.mjs — read-only windows onto the device gateway.
// devices.json stores plaintext bearer tokens (mode 0600), so the single most
// important property of these routes is that a token never leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PairingStore } from '../gateway/device_auth.mjs';
import * as views from '../daemon/routes/gateway_views.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-gwv-')); }
function mockRes() {
  return { code: 0, headers: null, body: null,
    writeHead(c, h) { this.code = c; this.headers = h; }, end(b) { this.body = b; } };
}

test('GET /approvals lists what is waiting, with the redacted summary', async () => {
  const res = mockRes();
  const gateway = {
    pendingApprovals: () => [
      { id: 'ap_1', createdAt: 1, tool: 'bash', agentId: 'backend', summary: 'npm run migrate' },
    ],
  };
  await views.approvalsList({ gateway, res });
  assert.equal(res.code, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.pending.length, 1);
  assert.equal(body.pending[0].tool, 'bash');
});

test('GET /approvals is empty, not an error, when the gateway is absent', async () => {
  const res = mockRes();
  await views.approvalsList({ gateway: null, res });
  assert.equal(res.code, 200);
  assert.deepEqual(JSON.parse(res.body), { pending: [] });
});

test('GET /devices never returns a bearer token', async () => {
  const dir = tmp();
  const store = new PairingStore(dir);
  const { requestId } = store.requestPairing({
    deviceId: 'sha256:aaa', platform: 'ios', label: 'phone', role: 'approver', scopes: [] });
  store.approve(requestId);
  // Sanity: the store really does hold a token for that device.
  assert.ok(store.tokenFor('sha256:aaa'), 'precondition — the store minted a token');

  const res = mockRes();
  await views.devicesList({ gwConfigDir: dir, gateway: { sseClients: new Set() }, res });
  assert.equal(res.code, 200);
  const raw = String(res.body);
  const token = store.tokenFor('sha256:aaa');
  // `"token"` with both quotes deliberately does NOT match `"tokenMasked"`, which
  // PairingStore.devicesList() does return — see the note below the test.
  assert.doesNotMatch(raw, /"token"/, 'no raw token field may appear');
  assert.equal(raw.includes(token), false, 'and not the value either');
  // Pin the mask's WIDTH, not just its presence. Without this, widening the mask
  // (or replacing it with the raw token minus one character) still passes both
  // assertions above, and the property this test exists to protect quietly weakens.
  const body = JSON.parse(raw);
  assert.match(body.devices[0].tokenMasked, /^.{6}….{4}$/,
    'the mask stays 6 leading + 4 trailing characters');
  for (let n = 12; n <= token.length; n += 1) {
    assert.equal(raw.includes(token.slice(0, n)), false,
      `no run of ${n} leading token characters may appear`);
  }

  assert.equal(body.devices.length, 1);
  assert.equal(body.devices[0].deviceId, 'sha256:aaa');
  assert.equal(body.devices[0].role, 'approver');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GET /devices reports pending pairing requests', async () => {
  const dir = tmp();
  const store = new PairingStore(dir);
  store.requestPairing({ deviceId: 'sha256:bbb', platform: 'android', label: 'tablet', role: 'read-only', scopes: [] });
  const res = mockRes();
  await views.devicesList({ gwConfigDir: dir, gateway: { sseClients: new Set() }, res });
  const body = JSON.parse(res.body);
  assert.equal(body.requests.length, 1);
  assert.equal(body.requests[0].label, 'tablet');
  assert.doesNotMatch(String(res.body), /"token"/);
  fs.rmSync(dir, { recursive: true, force: true });
});
