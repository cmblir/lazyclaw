import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openThreads } from '../channels/threads.mjs';

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lzc-threads-'));
  return d;
}

test('threads: upsert assigns sessionId and persists across reopen', async () => {
  const dir = tmpDir();
  const t1 = openThreads(dir);
  const row = t1.upsert({ channel: 'slack', externalId: 'C123:1700.0001', sessionId: 's-abc' });
  assert.equal(row.channel, 'slack');
  assert.equal(row.externalId, 'C123:1700.0001');
  assert.equal(row.sessionId, 's-abc');
  assert.ok(row.threadId && row.threadId.length >= 8);
  assert.ok(row.lastTurnAt > 0);

  const t2 = openThreads(dir);
  const found = t2.findByExternal('slack', 'C123:1700.0001');
  assert.equal(found?.sessionId, 's-abc');
  assert.equal(found?.threadId, row.threadId);
});

test('threads: handoff rewrites channel + externalId, preserves sessionId + threadId', async () => {
  const dir = tmpDir();
  const t = openThreads(dir);
  const a = t.upsert({ channel: 'telegram', externalId: '42:9001', sessionId: 's-xyz' });
  const b = t.handoff(a.threadId, { channel: 'discord', externalId: '999000111' });
  assert.equal(b.threadId, a.threadId, 'threadId is stable across handoff');
  assert.equal(b.sessionId, 's-xyz', 'sessionId is preserved');
  assert.equal(b.channel, 'discord');
  assert.equal(b.externalId, '999000111');
  // Old external mapping must be gone
  assert.equal(t.findByExternal('telegram', '42:9001'), null);
  assert.equal(t.findByExternal('discord', '999000111').threadId, a.threadId);
});

test('threads: handoff on unknown threadId throws THREAD_NOT_FOUND', async () => {
  const dir = tmpDir();
  const t = openThreads(dir);
  assert.throws(() => t.handoff('does-not-exist', { channel: 'http', externalId: 'r1' }),
    /THREAD_NOT_FOUND/);
});

test('threads: jsonl file is append-only (no rewrite on upsert)', async () => {
  const dir = tmpDir();
  const t = openThreads(dir);
  t.upsert({ channel: 'matrix', externalId: '!room:srv', sessionId: 's1' });
  const sizeAfter1 = fs.statSync(path.join(dir, 'threads.jsonl')).size;
  t.upsert({ channel: 'matrix', externalId: '!room:srv', sessionId: 's1' }); // touch
  const sizeAfter2 = fs.statSync(path.join(dir, 'threads.jsonl')).size;
  assert.ok(sizeAfter2 > sizeAfter1, 'second upsert appended a touch record');
});
