// Phase A: SQLite + FTS5 index (spec §4.2, §4.3, §4.8, §4.9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  openIndex, closeIndex, indexSessionTurn, indexSkill,
  indexTrajectory, indexMemory, recall, integrityCheck, rebuild,
} from '../mas/index_db.mjs';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-idx-'));
}

test('openIndex creates the db file and runs PRAGMA integrity_check', () => {
  const dir = tmp();
  const db = openIndex(dir);
  assert.ok(db, 'returns a db handle');
  assert.ok(fs.existsSync(path.join(dir, 'index.db')));
  const integ = integrityCheck(dir);
  assert.equal(integ.ok, true, JSON.stringify(integ));
  closeIndex(dir);
});

test('schema contains all four FTS5 virtual tables', () => {
  const dir = tmp();
  const db = openIndex(dir);
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name);
  for (const want of ['fts_sessions', 'fts_skills', 'fts_trajectories', 'fts_memories']) {
    assert.ok(tables.includes(want), `${want} missing; got ${tables.join(',')}`);
  }
  closeIndex(dir);
});

test('write-through hooks insert and recall round-trips', () => {
  const dir = tmp();
  openIndex(dir);
  indexSessionTurn({ session_id: 's1', turn_idx: 0, role: 'user',
    ts: 1, content: 'how do I refactor mjs imports' }, dir);
  indexSkill({ skill_name: 'refactor-mjs-imports', trained_by: 'claude-cli',
    group_name: 'dev', content: 'Refactor and reorganise ESM imports in .mjs files' }, dir);
  indexTrajectory({ trajectory_id: 't1', agent: 'worker-0', outcome: 'done',
    content: 'used mas/tools/edit to rewrite imports' }, dir);
  indexMemory({ topic: 'esm', kind: 'episodic',
    content: 'user prefers named exports' }, dir);

  const hits = recall('refactor', { configDir: dir });
  assert.ok(hits.hits.length >= 2, `expected >=2 hits, got ${hits.hits.length}`);
  const scopes = new Set(hits.hits.map(h => h.scope));
  assert.ok(scopes.has('sessions') || scopes.has('skills'));
  closeIndex(dir);
});

test('recall on 10k rows completes in <50ms (spec §4.9)', () => {
  const dir = tmp();
  openIndex(dir);
  for (let i = 0; i < 10000; i++) {
    indexSessionTurn({ session_id: `s${i}`, turn_idx: 0, role: 'user',
      ts: i, content: `synthetic turn number ${i} about widgets and gizmos` }, dir);
  }
  // Warm the query plan twice, then take median of 5 to absorb GC / scheduler jitter
  // under combined test runs. Spec §4.9 budget is per-query, not per-test-run.
  recall('widgets', { configDir: dir, k: 10 });
  recall('widgets', { configDir: dir, k: 10 });
  const samples = [];
  let out;
  for (let i = 0; i < 5; i++) {
    const t0 = process.hrtime.bigint();
    out = recall('gizmos', { configDir: dir, k: 10 });
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const median = samples[2];
  assert.ok(out.hits.length === 10, `got ${out.hits.length} hits`);
  assert.ok(median < 50, `recall median=${median.toFixed(2)}ms (samples=${samples.map(s => s.toFixed(1)).join(',')}), budget 50ms`);
  closeIndex(dir);
});

test('rebuild() recreates schema and is idempotent', () => {
  const dir = tmp();
  openIndex(dir);
  indexSessionTurn({ session_id: 'pre', turn_idx: 0, role: 'user', ts: 0,
    content: 'before rebuild' }, dir);
  closeIndex(dir);
  rebuild(dir);
  rebuild(dir);   // second call must not throw
  const integ = integrityCheck(dir);
  assert.equal(integ.ok, true);
  closeIndex(dir);
});
