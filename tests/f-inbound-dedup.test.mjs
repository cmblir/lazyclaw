// tests/f-inbound-dedup.test.mjs — Phase 4: /inbound idempotency.
// A channel retry (Slack redelivery, listener restart replay, app_mention +
// message double-fire reaching the daemon from two listener processes) must
// not produce a second provider call or a second appendTurn. The dedup store
// claims a {channel}:{messageId} key BEFORE the turn is persisted, records
// the reply after, replays the recorded reply on a duplicate, and survives a
// daemon restart (persisted jsonl).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDedup, _resetDedupCache } from '../daemon/lib/inbound_dedup.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lz-dedup-'));
}

test('fresh key claims; duplicate replays the recorded reply', () => {
  const dir = tmpDir();
  const d = openDedup(dir);
  const c1 = d.claim('slack:C1:111.222');
  assert.equal(c1.dup, false);
  d.record('slack:C1:111.222', { reply: 'answer', threadId: 'th_1', sessionId: 'ib_a' });
  const c2 = d.claim('slack:C1:111.222');
  assert.equal(c2.dup, true);
  assert.equal(c2.pending, false);
  assert.deepEqual({ reply: c2.entry.reply, threadId: c2.entry.threadId, sessionId: c2.entry.sessionId },
    { reply: 'answer', threadId: 'th_1', sessionId: 'ib_a' });
});

test('in-flight duplicate (claimed, not yet recorded) -> dup+pending', () => {
  const d = openDedup(tmpDir());
  assert.equal(d.claim('k1').dup, false);
  const c = d.claim('k1');
  assert.equal(c.dup, true);
  assert.equal(c.pending, true);
});

test('release() frees a claimed key (provider error path) so a retry works', () => {
  const d = openDedup(tmpDir());
  assert.equal(d.claim('k1').dup, false);
  d.release('k1');
  assert.equal(d.claim('k1').dup, false, 'retry after release must claim fresh');
});

test('pending claims expire (a crash between claim and record cannot wedge the key)', () => {
  let t = 1000;
  const d = openDedup(tmpDir(), { pendingTtlMs: 50, now: () => t });
  assert.equal(d.claim('k1').dup, false);
  t += 30;
  assert.equal(d.claim('k1').pending, true, 'still pending inside the TTL');
  t += 100;
  assert.equal(d.claim('k1').dup, false, 'expired pending claim is reclaimable');
});

test('recorded entries persist across reopen (daemon restart)', () => {
  const dir = tmpDir();
  const d1 = openDedup(dir);
  d1.claim('telegram:42');
  d1.record('telegram:42', { reply: 'r', threadId: 'th', sessionId: 's' });
  _resetDedupCache();
  const d2 = openDedup(dir);
  const c = d2.claim('telegram:42');
  assert.equal(c.dup, true);
  assert.equal(c.entry.reply, 'r');
});

test('openDedup caches one instance per dir (daemon is long-lived)', () => {
  const dir = tmpDir();
  assert.equal(openDedup(dir), openDedup(dir));
});

test('memory + file are capped: oldest keys evict, newest survive reopen', () => {
  const dir = tmpDir();
  const d = openDedup(dir, { cap: 10 });
  for (let i = 0; i < 35; i++) {
    d.claim(`k${i}`);
    d.record(`k${i}`, { reply: `r${i}`, threadId: 't', sessionId: 's' });
  }
  assert.equal(d.claim('k0').dup, false, 'oldest evicted');
  d.release('k0');
  assert.equal(d.claim('k34').dup, true, 'newest kept');
  _resetDedupCache();
  const d2 = openDedup(dir, { cap: 10 });
  assert.equal(d2.claim('k34').dup, true, 'newest survives reopen after compaction');
  const lines = fs.readFileSync(path.join(dir, 'inbound_seen.jsonl'), 'utf8').trim().split('\n');
  assert.ok(lines.length <= 40, `file stays bounded (got ${lines.length})`);
});

test('dedup file is written owner-only (0600)', () => {
  const dir = tmpDir();
  const d = openDedup(dir);
  d.claim('k'); d.record('k', { reply: 'x', threadId: 't', sessionId: 's' });
  const mode = fs.statSync(path.join(dir, 'inbound_seen.jsonl')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('corrupt lines in the persisted file are skipped, not fatal', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'inbound_seen.jsonl'),
    'not json\n' + JSON.stringify({ key: 'good', reply: 'r', threadId: 't', sessionId: 's', at: 1 }) + '\n{broken\n',
    { mode: 0o600 });
  const d = openDedup(dir);
  assert.equal(d.claim('good').dup, true);
});
