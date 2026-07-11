// tests/f-phase3-workflow-durability.test.mjs
//
// Phase 3 wave-A workflow-durability hardening. Proves (additive, opt-in,
// backward-compatible):
//   (a) a second runPersistent on a LOCKED sessionId refuses (no double
//       side-effect) instead of racing the state file;
//   (b) a STALE lock (dead pid / old mtime) is reclaimed, not wedged;
//   (c) a node with onError:'continue' does NOT fail the run on a non-timeout
//       error;
//   (d) validateWorkflow with { strictDeps } FAILS on an unknown dep;
//   (e) resume reads the engine mode (sequential vs parallel-persistent) from
//       the persisted state file.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { acquireSessionLock, lockPath, DEFAULT_LOCK_TTL_MS } from '../workflow/session_lock.mjs';
import { runPersistent, runPersistentDag, loadState } from '../workflow/persistent.mjs';
import { validateWorkflow, WorkflowError } from '../workflow/declarative.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc-p3wf-'));

// ───── (a) session lock refuses a concurrent run on the same sessionId ─────

test('acquireSessionLock: a second live acquire on the same sessionId refuses (SESSION_LOCKED)', () => {
  const dir = tmp();
  const first = acquireSessionLock('sess-lock', dir);
  assert.ok(fs.existsSync(lockPath('sess-lock', dir)), 'lockfile created');
  assert.throws(
    () => acquireSessionLock('sess-lock', dir),
    (e) => e.code === 'SESSION_LOCKED',
    'second acquire while first is held must refuse',
  );
  first.release();
  // After release the session is free again.
  const again = acquireSessionLock('sess-lock', dir);
  again.release();
});

test('runPersistent: a second concurrent run on a locked session refuses instead of double-executing', async () => {
  const dir = tmp();
  const sid = 'no-double';
  // Hold the lock as if another process were mid-run.
  const held = acquireSessionLock(sid, dir);
  let sideEffects = 0;
  const nodes = [{ id: 'x', type: 't', async execute() { sideEffects++; return 1; } }];
  const r = await runPersistent(nodes, { sessionId: sid, dir });
  assert.equal(r.success, false);
  assert.equal(r.code, 'SESSION_LOCKED', 'run refused because the session is locked');
  assert.equal(sideEffects, 0, 'the side-effecting node never ran');
  held.release();
  // Once free, the same run proceeds normally.
  const r2 = await runPersistent(nodes, { sessionId: sid, dir });
  assert.equal(r2.success, true);
  assert.equal(sideEffects, 1);
});

test('runPersistent: lock is released on the success path so a follow-up run can acquire it', async () => {
  const dir = tmp();
  const sid = 'released';
  const nodes = [{ id: 'x', type: 't', async execute() { return 1; } }];
  const r = await runPersistent(nodes, { sessionId: sid, dir });
  assert.equal(r.success, true);
  assert.ok(!fs.existsSync(lockPath(sid, dir)), 'lockfile removed after run');
  // Acquire should succeed (proves the finally released it).
  const h = acquireSessionLock(sid, dir);
  h.release();
});

// ───── (b) a stale lock is reclaimed ─────

test('acquireSessionLock: a stale lock (dead pid) is reclaimed', () => {
  const dir = tmp();
  // Hand-write a lock owned by a pid we assert is dead.
  const first = acquireSessionLock('stale-pid', dir, { pidAlive: () => true });
  const h = acquireSessionLock('stale-pid', dir, { pidAlive: () => false });
  assert.equal(h.reclaimed, true, 'dead-pid lock reclaimed');
  h.release();
  first.release?.(); // no-op: the reclaim removed the original lock content
});

test('acquireSessionLock: a stale lock (age past TTL) is reclaimed', () => {
  const dir = tmp();
  const t0 = 1_000_000;
  acquireSessionLock('stale-age', dir, { now: t0, pidAlive: () => true });
  // A much later acquire sees the old startedAt exceed the TTL → reclaim.
  const h = acquireSessionLock('stale-age', dir, {
    now: t0 + DEFAULT_LOCK_TTL_MS + 1,
    pidAlive: () => true,
  });
  assert.equal(h.reclaimed, true, 'aged-out lock reclaimed');
  h.release();
});

test('runPersistent: a stale lock does not wedge the session', async () => {
  const dir = tmp();
  const sid = 'wedge';
  // Simulate a crashed prior run: a lock owned by a dead pid.
  acquireSessionLock(sid, dir, { pidAlive: () => false, now: 1 });
  // Overwrite the lock so it references an obviously-dead pid.
  fs.writeFileSync(lockPath(sid, dir), JSON.stringify({ pid: 2 ** 30, startedAt: 1 }));
  let ran = false;
  const nodes = [{ id: 'x', type: 't', async execute() { ran = true; return 1; } }];
  const r = await runPersistent(nodes, { sessionId: sid, dir, lockPidAlive: () => false });
  assert.equal(r.success, true, 'run proceeded by reclaiming the stale lock');
  assert.equal(ran, true);
});

// ───── (c) onError:'continue' ─────

test('runPersistent: onError:"continue" does not fail the run on a non-timeout error', async () => {
  const dir = tmp();
  const nodes = [
    { id: 'a', type: 't', async execute() { return 'A'; } },
    { id: 'b', type: 't', onError: 'continue', async execute() { throw new Error('boom-not-timeout'); } },
    { id: 'c', type: 't', async execute() { return 'C'; } },
  ];
  const r = await runPersistent(nodes, { sessionId: 'cont-seq', dir });
  assert.equal(r.success, true, 'run succeeds despite b throwing (onError:continue)');
  assert.ok(r.executedNodes.includes('c'), 'c ran after b was skipped');
  const s = loadState('cont-seq', dir);
  assert.equal(s.nodes.b.status, 'skipped', 'b recorded as skipped, not failed');
  assert.equal(s.nodes.c.status, 'success');
});

test('runPersistentDag: onError:"continue" lets independent downstream nodes proceed', async () => {
  const dir = tmp();
  const nodes = [
    { id: 'a', deps: [], onError: 'continue', async execute() { throw new Error('a-boom'); } },
    { id: 'b', deps: [], async execute() { return 'B'; } },
  ];
  const r = await runPersistentDag(nodes, { sessionId: 'cont-dag', dir });
  assert.equal(r.success, true, 'DAG run succeeds — a skipped, b succeeds');
  const s = loadState('cont-dag', dir);
  assert.equal(s.nodes.a.status, 'skipped');
  assert.equal(s.nodes.b.status, 'success');
});

test('runPersistent: default (no onError) keeps current fail-fast behavior on a non-timeout error', async () => {
  const dir = tmp();
  const nodes = [
    { id: 'a', type: 't', async execute() { throw new Error('boom'); } },
    { id: 'b', type: 't', async execute() { return 'B'; } },
  ];
  const r = await runPersistent(nodes, { sessionId: 'ff', dir, maxRetries: 1 });
  assert.equal(r.success, false, 'default behavior unchanged: run fails at a');
  assert.equal(r.failedAt, 'a');
});

// ───── (d) strict dep validation ─────

test('validateWorkflow: { strictDeps } fails on an unknown dep', () => {
  const def = { nodes: [{ id: 'a', type: 'set', deps: ['ghost'] }] };
  // Default (lenient) does NOT throw — backward-compatible.
  assert.doesNotThrow(() => validateWorkflow(def), 'lenient default unchanged');
  // strictDeps promotes the unknown dep to a hard failure.
  assert.throws(
    () => validateWorkflow(def, { strictDeps: true }),
    (e) => e instanceof WorkflowError && e.code === 'WF_UNKNOWN_DEP' && /ghost/.test(e.message),
  );
});

test('validateWorkflow: { strictDeps } passes when every dep resolves', () => {
  const def = {
    nodes: [
      { id: 'a', type: 'set' },
      { id: 'b', type: 'set', deps: ['a'] },
    ],
  };
  assert.doesNotThrow(() => validateWorkflow(def, { strictDeps: true }));
});

// ───── (e) resume auto-selects the engine from persisted state ─────

test('runPersistent persists engine mode + deps in the state file', async () => {
  const dir = tmp();
  const nodes = [{ id: 'a', type: 't', deps: [], async execute() { return 'A'; } }];
  await runPersistent(nodes, { sessionId: 'mode-seq', dir });
  const s = loadState('mode-seq', dir);
  assert.equal(s.engine, 'sequential', 'sequential engine recorded');
});

test('runPersistentDag persists engine mode + deps in the state file', async () => {
  const dir = tmp();
  const nodes = [
    { id: 'a', deps: [], async execute() { return 'A'; } },
    { id: 'b', deps: ['a'], async execute(input) { return `B:${input.a}`; } },
  ];
  await runPersistentDag(nodes, { sessionId: 'mode-dag', dir });
  const s = loadState('mode-dag', dir);
  assert.equal(s.engine, 'parallel-persistent', 'parallel-persistent engine recorded');
  assert.deepEqual(s.deps.b, ['a'], 'deps persisted so critical-path/resume needn\'t re-read the .mjs');
});

test('resumeEngineFromState reports the engine recorded by the original run', async () => {
  const dir = tmp();
  const { resumeEngineFromState } = await import('../workflow/persistent.mjs');
  const dagNodes = [
    { id: 'a', deps: [], async execute() { return 'A'; } },
    { id: 'b', deps: ['a'], async execute(input) { return `B:${input.a}`; } },
  ];
  await runPersistentDag(dagNodes, { sessionId: 'auto-dag', dir });
  assert.equal(resumeEngineFromState('auto-dag', dir), 'parallel-persistent');

  const seqNodes = [{ id: 'a', type: 't', async execute() { return 'A'; } }];
  await runPersistent(seqNodes, { sessionId: 'auto-seq', dir });
  assert.equal(resumeEngineFromState('auto-seq', dir), 'sequential');

  // Unknown session → null (caller falls back to the flag / default).
  assert.equal(resumeEngineFromState('nope', dir), null);
});

test('persisted deps let a critical-path be computed WITHOUT re-reading the .mjs', async () => {
  const dir = tmp();
  const nodes = [
    { id: 'a', deps: [], async execute() { return 'A'; } },
    { id: 'b', deps: ['a'], async execute(input) { return `B:${input.a}`; } },
    { id: 'c', deps: ['b'], async execute(input) { return `C:${input.b}`; } },
  ];
  await runPersistentDag(nodes, { sessionId: 'cp', dir });
  const s = loadState('cp', dir);
  // Reconstruct graphNodes purely from persisted state (order + deps) — the
  // same reconstruction `inspect --critical-path` (no file) performs.
  const graphNodes = (s.order || []).map((id) => ({ id, deps: s.deps[id] || [] }));
  const { criticalPath } = await import('../workflow/summary.mjs');
  const result = criticalPath(graphNodes, s.nodes || {});
  assert.deepEqual(result.path, ['a', 'b', 'c'], 'critical path derived from persisted deps alone');
});
