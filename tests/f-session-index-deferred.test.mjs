// tests/f-session-index-deferred.test.mjs
//
// The chat reply path calls sessions.appendTurn() before the answer is
// flushed to the client. appendTurn used to run the FTS5 mirror write
// (better-sqlite3, fully synchronous) inline via a static import, so a
// synchronous SQLite INSERT — and the first-turn schema-create — blocked
// the user-visible reply. These pin the contract that:
//   1. the JSONL log (durable source of truth) is written synchronously, and
//   2. the FTS mirror write is deferred OFF the calling tick (so it never
//      sits on the reply latency path), yet still lands eventually.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendTurn, loadTurns } from '../sessions.mjs';
import * as idx from '../mas/index_db.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaw-sidx-'));
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

test('appendTurn writes the JSONL log synchronously (durable source of truth)', () => {
  const dir = tmp();
  appendTurn('s1', 'user', 'sync-durable-marble', dir);
  // No await — the log must be readable on the same tick appendTurn returned.
  const turns = loadTurns('s1', dir);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].content, 'sync-durable-marble');
});

test('the FTS mirror write is deferred off the reply tick, then lands', async () => {
  const dir = tmp();
  appendTurn('s2', 'user', 'deferred-zelphorium-token', dir);
  // Synchronously right after appendTurn: the FTS row must NOT be there yet —
  // proving the SQLite write was pushed off the reply path, not run inline.
  const immediate = idx.recall('zelphorium', { configDir: dir, scope: ['sessions'] }).hits;
  assert.equal(immediate.length, 0, 'FTS write must not run on the synchronous reply tick');
  // After ticks drain, the deferred write has landed and the turn is recallable.
  await settle();
  const eventual = idx.recall('zelphorium', { configDir: dir, scope: ['sessions'] }).hits;
  assert.ok(eventual.length > 0, 'deferred turn must be recallable once ticks drain');
});
