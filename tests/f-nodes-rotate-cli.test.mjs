// tests/f-nodes-rotate-cli.test.mjs
//
// Roadmap #6b — `pompos nodes rotate <deviceId>` re-issues a device's token
// in place (no new pairing handshake). Like approve, it NEVER prints the token
// (the device re-fetches it on its next /gateway/connect); the old token stops
// authenticating immediately.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PairingStore } from '../gateway/device_auth.mjs';

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-noderot-'));
const runCli = (args, dir) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, POMPOS_CONFIG_DIR: dir }, encoding: 'utf8' });

test('nodes rotate re-issues a token without printing it; the old token is revoked', () => {
  const dir = tmp();
  const store = new PairingStore(dir);
  const { requestId } = store.requestPairing({ deviceId: 'sha256:cli', platform: 'cli' });
  const { token: old } = store.approve(requestId, {});

  const r = runCli(['nodes', 'rotate', 'sha256:cli'], dir);
  assert.equal(r.status, 0, `rotate should exit 0; stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.rotated, 'sha256:cli');
  assert.ok(!('token' in out), 'the token must NOT be printed to the terminal');

  const store2 = new PairingStore(dir); // fresh read from disk
  assert.equal(store2.verifyToken('sha256:cli', old), false, 'the old token no longer authenticates');
});

test('nodes rotate --ttl stamps an expiry', () => {
  const dir = tmp();
  const store = new PairingStore(dir);
  const { requestId } = store.requestPairing({ deviceId: 'sha256:cli2' });
  store.approve(requestId, {});
  const r = runCli(['nodes', 'rotate', 'sha256:cli2', '--ttl', '60000'], dir);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.ok(JSON.parse(r.stdout).expiresAt, 'an expiresAt is returned when --ttl is given');
});

test('nodes rotate without a deviceId is a usage error (exit 2)', () => {
  const r = runCli(['nodes', 'rotate'], tmp());
  assert.equal(r.status, 2);
});

test('nodes rotate of an unknown device fails (exit 1)', () => {
  const r = runCli(['nodes', 'rotate', 'sha256:ghost'], tmp());
  assert.equal(r.status, 1);
});
