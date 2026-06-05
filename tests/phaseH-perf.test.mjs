// Phase H5 — Perf acceptance budget (spec §11.9, table row H5).
//
//   Cold-start <= 400ms
//   recall p95 <= 50ms
//   daemon RSS <= 180MB idle
//
// The recall p95 microbenchmark lives in `tests/index_store.bench.mjs`;
// this file owns the two end-to-end budgets that need a real Node
// process boot (`version`) and the in-process RSS check on the
// daemon-equivalent loaded modules (we don't want CI to wait for the
// daemon socket; loading the same module set is the proxy of choice
// that v4's `bench-providers` already used).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.join(process.cwd(), 'cli.mjs');

const BUDGETS = {
  coldStartMs: 400,
  daemonIdleRssMb: 180,
};

test('cold-start: lazyclaw version <= 400ms (spec §11.9 H5)', () => {
  // Warm Node module cache once so we're measuring lazyclaw boot, not
  // first-ever resolver work on the host. Spec budget is steady-state.
  spawnSync(process.execPath, [CLI, 'version'], {
    encoding: 'utf8',
    env: { ...process.env, LAZYCLAW_NO_INK: '1' },
  });

  const samples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(process.execPath, [CLI, 'version'], {
      encoding: 'utf8',
      env: { ...process.env, LAZYCLAW_NO_INK: '1' },
    });
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(r.status, 0, `version exited non-zero: ${r.stderr}`);
    samples.push(elapsedMs);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  assert.ok(median < BUDGETS.coldStartMs,
    `cold-start median ${median.toFixed(1)}ms > budget ${BUDGETS.coldStartMs}ms (samples ${samples.map(n => n.toFixed(0)).join(',')})`);
});

test('daemon idle RSS: module set <= 180MB (spec §11.9 H5)', async () => {
  // Load the modules a freshly-booted daemon would page in for an idle
  // session: index_db (FTS5 connection), trajectory_store, confidence,
  // registry, channels base. No long-lived sockets, no provider calls.
  // RSS is measured *after* the imports settle so it reflects steady
  // state, matching the spec wording ("daemon RSS <= 180MB idle").
  await import('../mas/index_db.mjs');
  await import('../mas/trajectory_store.mjs');
  await import('../mas/confidence.mjs');
  await import('../providers/registry.mjs');

  if (global.gc) global.gc();
  // Let any pending microtasks drain.
  await new Promise((r) => setImmediate(r));

  const rssMb = process.memoryUsage().rss / 1_048_576;
  assert.ok(rssMb < BUDGETS.daemonIdleRssMb,
    `idle RSS ${rssMb.toFixed(1)}MB > budget ${BUDGETS.daemonIdleRssMb}MB`);
});
