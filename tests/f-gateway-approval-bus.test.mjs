// tests/f-gateway-approval-bus.test.mjs — the device gateway's approval events
// must reach the daemon's own event bus, because that bus is what feeds the
// dashboard's SSE stream.
//
// Before this bridge, gateway.broadcast() fanned out only to device-authenticated
// SSE clients and gateway/ imported mas/events.mjs nowhere, so the Approvals
// sidebar badge never moved while the user sat on another panel — it updated only
// when the panel itself loaded. The crossing is an explicit allowlist rather than
// a blanket mirror, so the `tick` keep-alive stays off the dashboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../gateway/http_gateway.mjs';
import { ChallengeRegistry } from '../gateway/device_auth.mjs';
import { subscribe, _reset } from '../mas/events.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-gw-bus-'));
}

// Collect bus events for the duration of one gateway's life.
function withBus(fn) {
  _reset();
  const seen = [];
  const off = subscribe((e) => seen.push(e));
  try { return fn(seen); } finally { off(); }
}

test('a pending approval reaches the bus with the same fields the device sees', () => {
  const dir = tmpDir();
  withBus((seen) => {
    const gw = createGateway({ configDir: dir, challengeRegistry: new ChallengeRegistry() });
    try {
      gw.requestApproval({ tool: 'bash', agentId: 'orchestrator', summary: 'rm -rf ./build' });
      const evt = seen.find((e) => e.type === 'exec.approval.requested');
      assert.ok(evt, 'exec.approval.requested must reach the bus');
      assert.equal(evt.tool, 'bash');
      assert.equal(evt.agentId, 'orchestrator');
      assert.match(evt.summary, /build/);
      assert.ok(typeof evt.id === 'string' && evt.id.startsWith('ap_'));
      // emit() stamps these; without them the dashboard's replay-on-connect
      // cannot order or dedupe the event.
      assert.ok(Number.isInteger(evt.seq) && evt.seq > 0);
      assert.ok(Number.isFinite(evt.ts));
    } finally { gw.close?.(); }
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolving an approval reaches the bus too, carrying the decision', () => {
  const dir = tmpDir();
  withBus((seen) => {
    const gw = createGateway({ configDir: dir, challengeRegistry: new ChallengeRegistry() });
    try {
      const { id } = gw.requestApproval({ tool: 'bash', agentId: 'a', summary: 's' });
      gw.resolveApproval(id, true, 'sha256:device');
      const evt = seen.find((e) => e.type === 'exec.approval.resolved');
      assert.ok(evt, 'exec.approval.resolved must reach the bus');
      assert.equal(evt.id, id);
      assert.equal(evt.approved, true);
      assert.equal(evt.by, 'sha256:device');
    } finally { gw.close?.(); }
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the heartbeat is NOT mirrored — the allowlist is doing work', () => {
  const dir = tmpDir();
  withBus((seen) => {
    // heartbeatMs is opt-in; a short one makes the gateway emit `tick` frames.
    const gw = createGateway({ configDir: dir, challengeRegistry: new ChallengeRegistry(), heartbeatMs: 1 });
    try {
      // Drive one approval so the bus is provably live in this same window —
      // otherwise "no tick" could just mean "no events at all", and the test
      // would pass against a bridge that mirrored nothing.
      gw.requestApproval({ tool: 'bash', agentId: 'a', summary: 's' });
      assert.ok(seen.some((e) => e.type === 'exec.approval.requested'), 'bus is live');
      assert.equal(seen.some((e) => e.type === 'tick'), false,
        'the keep-alive heartbeat must not reach the dashboard bus');
    } finally { gw.close?.(); }
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no approval payload carries a secret-shaped field', () => {
  const dir = tmpDir();
  withBus((seen) => {
    const gw = createGateway({ configDir: dir, challengeRegistry: new ChallengeRegistry() });
    try {
      const { id } = gw.requestApproval({
        tool: 'bash', agentId: 'a',
        // approvalView redacts the summary; assert the redaction survives the
        // trip onto the bus rather than trusting it happens upstream.
        summary: 'curl -H "authorization: Bearer sk-ant-SECRETVALUE" https://x',
      });
      gw.resolveApproval(id, false, 'sha256:device');
      const FORBIDDEN = /token|secret|apikey|api_key|password|authorization/i;
      for (const e of seen) {
        for (const k of Object.keys(e)) {
          assert.doesNotMatch(k, FORBIDDEN, `${e.type} must not carry a "${k}" field`);
        }
        for (const v of Object.values(e)) {
          if (typeof v !== 'string') continue;
          assert.equal(v.includes('sk-ant-SECRETVALUE'), false,
            `${e.type} leaked a secret from the summary onto the bus`);
        }
      }
    } finally { gw.close?.(); }
  });
  fs.rmSync(dir, { recursive: true, force: true });
});
