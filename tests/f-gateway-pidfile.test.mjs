// tests/f-gateway-pidfile.test.mjs — the gateway records a pidfile so
// `/gateway status` and `/gateway stop` can find a running instance, and the
// shared pidfile helpers treat a dead pid as "not running" + self-heal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pidfileStatus, pidfileStop } from '../commands/daemon.mjs';
import { _gatewayPidfilePath, gatewayStatus, gatewayStop } from '../commands/gateway.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaw-gw-'));
}

test('_gatewayPidfilePath sits next to the daemon pidfile', () => {
  assert.equal(_gatewayPidfilePath('/cfg'), path.join('/cfg', 'gateway.pid'));
});

test('pidfileStatus reports a live pid as running', () => {
  const dir = tmpDir();
  const pf = path.join(dir, 'gateway.pid');
  fs.writeFileSync(pf, JSON.stringify({ pid: 4242, port: 19600 }));
  const st = pidfileStatus(pf, { isAlive: (pid) => pid === 4242 });
  assert.deepEqual(st, { running: true, pid: 4242, port: 19600 });
});

test('pidfileStatus removes a stale pidfile and reports not-running', () => {
  const dir = tmpDir();
  const pf = path.join(dir, 'gateway.pid');
  fs.writeFileSync(pf, JSON.stringify({ pid: 4242, port: 19600 }));
  const st = pidfileStatus(pf, { isAlive: () => false });
  assert.equal(st.running, false);
  assert.equal(fs.existsSync(pf), false, 'stale pidfile must be cleaned up');
});

test('pidfileStatus treats a missing or corrupt pidfile as not-running', () => {
  const dir = tmpDir();
  assert.deepEqual(
    pidfileStatus(path.join(dir, 'nope.pid'), { isAlive: () => true }),
    { running: false, pid: null, port: null },
  );
  const bad = path.join(dir, 'gateway.pid');
  fs.writeFileSync(bad, 'not json');
  assert.equal(pidfileStatus(bad, { isAlive: () => true }).running, false);
});

test('pidfileStop SIGTERMs the recorded pid and removes the pidfile', () => {
  const dir = tmpDir();
  const pf = path.join(dir, 'gateway.pid');
  fs.writeFileSync(pf, JSON.stringify({ pid: 777, port: 19600 }));
  const signals = [];
  let alive = true;
  const res = pidfileStop(pf, {
    isAlive: () => alive,
    kill: (pid, sig) => { signals.push([pid, sig]); alive = false; },
  });
  assert.deepEqual(signals, [[777, 'SIGTERM']]);
  assert.equal(res.running, true);
  assert.equal(res.killed, true);
  assert.equal(fs.existsSync(pf), false);
});

test('gatewayStatus / gatewayStop delegate to the gateway pidfile', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'gateway.pid'), JSON.stringify({ pid: 99, port: 19600 }));
  const st = gatewayStatus({ configDir: dir }, { isAlive: (p) => p === 99 });
  assert.deepEqual(st, { running: true, pid: 99, port: 19600 });

  const stopped = gatewayStop({ configDir: dir }, {
    isAlive: () => false,
    kill: () => { throw new Error('must not signal a dead pid'); },
  });
  assert.equal(stopped.running, false);
});
