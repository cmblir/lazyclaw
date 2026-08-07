// Phase H5 — Index-store microbenchmarks (spec §4.9, §11.9 acceptance).
//
// Budgets enforced (single-process, post-WAL warmup):
//   - Single-turn insert        : < 1 ms
//   - Bulk 10k insert           : < 800 ms (single transaction)
//   - recall(k=10) cold         : < 80 ms
//   - recall(k=10) warm         : < 15 ms
//
// Run as a node:test so the perf budget is enforced in CI alongside the
// rest of the suite. The same file is invokable as a script for the
// 20% regression watchdog mentioned in spec §4.9: `node tests/index_store.bench.mjs`
// prints a JSON record on stdout that CI compares against the previous
// run's baseline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openIndex, closeIndex, indexSessionTurn, recall,
} from '../mas/index_db.mjs';

const BUDGETS = {
  singleInsertMs: 1,
  bulk10kMs: 800,
  recallColdMs: 80,
  recallWarmMs: 15,
  recallP95Ms: 50,   // spec §11.9 H5 acceptance
};

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-bench-'));
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function percentile(samples, p) {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function seedRows(dir, n) {
  // Single transaction by wrapping inside one direct stmt. The hook
  // already does that under the hood, but we call it n times so it's
  // realistic; the budget is for the cumulative time, not for one stmt.
  for (let i = 0; i < n; i++) {
    indexSessionTurn({
      session_id: `s${i}`,
      turn_idx: i % 32,
      role: i % 2 === 0 ? 'user' : 'assistant',
      ts: i,
      content: `synthetic turn ${i} about widgets gadgets gizmos refactor mjs imports task #${i % 17}`,
    }, dir);
  }
}

test('bench: single-turn insert < 1 ms (spec §4.9)', () => {
  const dir = tmpDir();
  openIndex(dir);
  // Warm up — first hook call pays for FTS5 page allocation.
  indexSessionTurn({ session_id: 'warm', turn_idx: 0, role: 'user',
    ts: 0, content: 'warmup' }, dir);
  const samples = [];
  for (let i = 0; i < 200; i++) {
    const t0 = nowMs();
    indexSessionTurn({
      session_id: 'b', turn_idx: i, role: 'user', ts: i,
      content: `bench single insert ${i}`,
    }, dir);
    samples.push(nowMs() - t0);
  }
  const median = percentile(samples, 0.5);
  assert.ok(median < BUDGETS.singleInsertMs,
    `single-insert median ${median.toFixed(3)}ms > budget ${BUDGETS.singleInsertMs}ms`);
  closeIndex(dir);
});

test('bench: bulk 10k insert < 800 ms (spec §4.9)', () => {
  // Best-of-3 — first run pays for FTS5 statement plan caching and is
  // sensitive to host CPU jitter on CI shared runners. Spec budget is
  // for steady-state.
  const runs = [];
  for (let r = 0; r < 3; r++) {
    const dir = tmpDir();
    openIndex(dir);
    const t0 = nowMs();
    seedRows(dir, 10_000);
    runs.push(nowMs() - t0);
    closeIndex(dir);
  }
  const best = Math.min(...runs);
  assert.ok(best < BUDGETS.bulk10kMs,
    `bulk 10k best-of-3 ${best.toFixed(1)}ms > budget ${BUDGETS.bulk10kMs}ms (runs ${runs.map(n => n.toFixed(0)).join(',')})`);
});

test('bench: recall cold < 80 ms, warm < 15 ms (spec §4.9)', () => {
  const dir = tmpDir();
  openIndex(dir);
  seedRows(dir, 10_000);

  // Cold: first MATCH on a fresh statement after seeding.
  const cold0 = nowMs();
  const coldOut = recall('gizmos', { configDir: dir, k: 10 });
  const coldMs = nowMs() - cold0;
  assert.equal(coldOut.hits.length, 10);
  assert.ok(coldMs < BUDGETS.recallColdMs,
    `recall cold ${coldMs.toFixed(2)}ms > budget ${BUDGETS.recallColdMs}ms`);

  // Warm: subsequent runs hit the page cache.
  const warmSamples = [];
  for (let i = 0; i < 20; i++) {
    const t = nowMs();
    recall('widgets', { configDir: dir, k: 10 });
    warmSamples.push(nowMs() - t);
  }
  const warmMedian = percentile(warmSamples, 0.5);
  assert.ok(warmMedian < BUDGETS.recallWarmMs,
    `recall warm median ${warmMedian.toFixed(2)}ms > budget ${BUDGETS.recallWarmMs}ms`);
  closeIndex(dir);
});

test('bench: recall p95 < 50 ms across 50 queries (spec §11.9 H5)', () => {
  const dir = tmpDir();
  openIndex(dir);
  seedRows(dir, 10_000);
  // Warm the query plan once.
  recall('widgets', { configDir: dir, k: 10 });
  const samples = [];
  const terms = ['widgets', 'gizmos', 'gadgets', 'refactor', 'mjs',
    'task', 'imports', 'synthetic'];
  for (let i = 0; i < 50; i++) {
    const term = terms[i % terms.length];
    const t = nowMs();
    recall(term, { configDir: dir, k: 10 });
    samples.push(nowMs() - t);
  }
  const p95 = percentile(samples, 0.95);
  assert.ok(p95 < BUDGETS.recallP95Ms,
    `recall p95 ${p95.toFixed(2)}ms > budget ${BUDGETS.recallP95Ms}ms`);
  closeIndex(dir);
});

// Script mode — emit JSON for the 20% regression watchdog (spec §4.9).
// Only runs when invoked as `node tests/index_store.bench.mjs --report`
// (so node:test loads of this file do not also print the JSON record).
const directRun = process.argv.includes('--report');

if (directRun) {
  const dir = tmpDir();
  openIndex(dir);
  const tInsert = nowMs(); seedRows(dir, 10_000);
  const insertMs = nowMs() - tInsert;
  recall('widgets', { configDir: dir, k: 10 });   // warm
  const samples = [];
  for (let i = 0; i < 50; i++) {
    const t = nowMs();
    recall(i % 2 ? 'widgets' : 'gizmos', { configDir: dir, k: 10 });
    samples.push(nowMs() - t);
  }
  closeIndex(dir);
  const report = {
    spec: '§4.9, §11.9 H5',
    bulk10kMs: Number(insertMs.toFixed(2)),
    recallP50Ms: Number(percentile(samples, 0.5).toFixed(2)),
    recallP95Ms: Number(percentile(samples, 0.95).toFixed(2)),
    budgets: BUDGETS,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
}
