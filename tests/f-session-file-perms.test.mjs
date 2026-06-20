// tests/f-session-file-perms.test.mjs — conversation logs can contain pasted
// secrets, but the source-of-truth files (session JSONL, recent.jsonl, core.md)
// were written with the default umask (often world/group-readable 0644). The
// FTS mirror was redacted; the raw files were not even owner-only. Tighten them
// to 0600 like config.json. (Pre-create each file 0644 so the test is reliably
// red without the fix regardless of the runner's umask.)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendTurn, sessionPath } from '../sessions.mjs';
import { appendRecent, setCore, recentPath, corePath, memoryDir } from '../memory.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc-perms-'));
const isOwnerOnly = (p) => (fs.statSync(p).mode & 0o077) === 0;

function preCreateLoose(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '');
  fs.chmodSync(p, 0o644);
}

test('appendTurn keeps the session JSONL owner-only (0600)', () => {
  const dir = tmp();
  const p = sessionPath('s1', dir);
  preCreateLoose(p);
  appendTurn('s1', 'user', 'my key is sk-abc', dir);
  assert.ok(isOwnerOnly(p), 'session JSONL must be 0600 (no group/other bits)');
});

test('appendRecent keeps recent.jsonl owner-only (0600)', () => {
  const dir = tmp();
  const p = recentPath(dir);
  preCreateLoose(p);
  appendRecent('s1', 'user', 'token xoxb-secret', dir);
  assert.ok(isOwnerOnly(p), 'recent.jsonl must be 0600');
});

test('setCore keeps core.md owner-only (0600)', () => {
  const dir = tmp();
  fs.mkdirSync(memoryDir(dir), { recursive: true });
  const p = corePath(dir);
  preCreateLoose(p);
  setCore('curated memory with a pasted secret', dir);
  assert.ok(isOwnerOnly(p), 'core.md must be 0600');
});
