// P0 security — secret files land owner-only (0600 file / 0700 dir).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonSecure, tightenIfLoose } from '../secure_write.mjs';

const isWin = process.platform === 'win32'; // POSIX mode bits are not meaningful on Windows

test('writeJsonSecure creates a 0600 file inside a 0700 dir', { skip: isWin }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-sw-'));
  const f = path.join(dir, 'sub', 'config.json');
  writeJsonSecure(f, { 'api-key': 'sk-secret' });
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8'))['api-key'], 'sk-secret');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
});

test('writeJsonSecure re-tightens a pre-existing world-readable file', { skip: isWin }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-sw2-'));
  const f = path.join(dir, 'config.json');
  fs.writeFileSync(f, '{}'); fs.chmodSync(f, 0o644);
  writeJsonSecure(f, { a: 1 });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test('tightenIfLoose tightens 0644 to 0600 and is idempotent', { skip: isWin }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-sw3-'));
  const f = path.join(dir, 'config.json');
  fs.writeFileSync(f, '{}'); fs.chmodSync(f, 0o644);
  assert.equal(tightenIfLoose(f), true);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(tightenIfLoose(f), false);
});

test('persistent.saveState writes state owner-only', { skip: isWin }, async () => {
  const { saveState, statePath } = await import('../workflow/persistent.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-sw4-'));
  saveState({ sessionId: 's', order: [], nodes: {}, startedAt: 0, updatedAt: 0 }, dir);
  assert.equal(fs.statSync(statePath('s', dir)).mode & 0o777, 0o600);
});
