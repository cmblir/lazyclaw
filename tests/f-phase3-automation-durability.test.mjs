// tests/f-phase3-automation-durability.test.mjs — Phase 3 wave-A
// automation-durability group. Hardens unattended loops + goal ticks:
//
//   (1) PER-SCHEDULE SINGLETON LOCK + overlap policy (default SKIP): a slow
//       loop/goal tick still running when the next fire arrives — or a manual
//       tick racing the scheduled one (separate processes) — must not both
//       open the same session and interleave/lose a check-in. A stale lock
//       (dead pid / TTL) is reclaimed. Released in finally on all paths.
//   (2) BUDGET GUARDRAILS on runLoop: opt-in wall-clock / max-tokens /
//       max-cost ceilings + a global kill-switch, surfaced as
//       stoppedBy:'budget'|'timeout'. Default (no budget) = today's behavior.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { acquire, withSingleton, DEFAULT_LOCK_TTL_MS } from '../lib/run_singleton.mjs';
import { runLoop, checkBudget } from '../loop-engine.mjs';
import { registerGoal, getGoal, patchGoal, appendCheckIn, withGoalLock, goalLocksDir } from '../goals.mjs';
import { runGoalTick } from '../goals_cron.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-p3-autodur-'));
}

// ---------------------------------------------------------------------------
// (1) Singleton lock + overlap policy
// ---------------------------------------------------------------------------

test('acquire: a second acquirer for the same name is SKIPPED while the first holds it', () => {
  const dir = tmpDir();
  const a = acquire('sweep', { dir });
  assert.equal(a.acquired, true, 'first acquirer wins');
  const b = acquire('sweep', { dir });
  assert.equal(b.acquired, false, 'second acquirer is skipped while lock held');
  assert.ok(b.holder && b.holder.pid, 'skip surfaces the current holder');
  a.release();
  const c = acquire('sweep', { dir });
  assert.equal(c.acquired, true, 'lock is re-acquirable after release');
  c.release();
});

test('acquire: different names do not block each other', () => {
  const dir = tmpDir();
  const a = acquire('one', { dir });
  const b = acquire('two', { dir });
  assert.equal(a.acquired, true);
  assert.equal(b.acquired, true, 'distinct names get independent locks');
  a.release();
  b.release();
});

test('acquire: a stale lock (dead pid) is reclaimed', () => {
  const dir = tmpDir();
  // A pid that is (almost certainly) not alive. process.kill(pid,0) throws
  // ESRCH → isPidAlive=false → stale → reclaimed.
  const deadPid = 2 ** 30;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stuck.lock'), JSON.stringify({ pid: deadPid, startedAt: Date.now(), ttlMs: DEFAULT_LOCK_TTL_MS }));
  const r = acquire('stuck', { dir });
  assert.equal(r.acquired, true, 'a dead-pid lock must be reclaimed');
  assert.equal(r.stolen, true, 'reclaim is flagged as stolen');
  r.release();
});

test('acquire: a stale lock (past TTL) is reclaimed even if the pid is alive', () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  // Our own (alive) pid, but startedAt far enough back that now-startedAt > ttl.
  fs.writeFileSync(path.join(dir, 'old.lock'), JSON.stringify({ pid: process.pid, startedAt: 1000, ttlMs: 50 }));
  const r = acquire('old', { dir, now: () => 1_000_000 });
  assert.equal(r.acquired, true, 'a lock older than its TTL must be reclaimed');
  r.release();
});

test('withSingleton: SKIP overlap means fn does not run while another holds the lock', async () => {
  const dir = tmpDir();
  const held = acquire('job', { dir }); // simulate an in-flight holder
  let ran = false;
  const out = await withSingleton('job', { dir }, () => { ran = true; return 'x'; });
  assert.equal(out.skipped, true, 'overlapping run is skipped');
  assert.equal(ran, false, 'skipped fn must NOT execute');
  held.release();
});

test('withSingleton: releases the lock in finally even when fn throws', async () => {
  const dir = tmpDir();
  await assert.rejects(
    () => withSingleton('boom', { dir }, () => { throw new Error('kaboom'); }),
    /kaboom/,
  );
  // Lock must be free afterwards.
  const r = acquire('boom', { dir });
  assert.equal(r.acquired, true, 'lock released after fn threw');
  r.release();
});

// ---------------------------------------------------------------------------
// (1) goal tick overlap: no interleaved / lost check-in
// ---------------------------------------------------------------------------

test('runGoalTick: a concurrent tick for the same goal is SKIPPED — no interleaved check-in', async () => {
  const dir = tmpDir();
  registerGoal({ name: 'ship', description: 'seed' }, dir);

  // The "runTick" appends exactly one check-in. We hold the goal lock
  // externally to simulate a slow tick already running in another process.
  const runTick = () => { appendCheckIn('ship', 'tick-ran', dir); return 'ok'; };

  const held = acquire('ship', { dir: goalLocksDir(dir) }); // in-flight holder
  const skipped = await runGoalTick({
    name: 'ship',
    withGoalLock: (n, fn, o) => withGoalLock(n, fn, { ...o, configDir: dir }),
    runTick,
  });
  assert.equal(skipped.skipped, true, 'second tick must be skipped while one runs');
  held.release();

  // Now no holder — the tick runs and lands exactly one check-in.
  const ran = await runGoalTick({
    name: 'ship',
    withGoalLock: (n, fn, o) => withGoalLock(n, fn, { ...o, configDir: dir }),
    runTick,
  });
  assert.equal(ran.skipped, false);
  const g = getGoal('ship', dir);
  assert.equal(g.checkIns.length, 1, 'exactly one check-in — the skipped tick added none');
  assert.equal(g.checkIns[0].summary, 'tick-ran');
});

test('withGoalLock: two overlapping ticks serialize to a single writer — no lost check-in', async () => {
  const dir = tmpDir();
  registerGoal({ name: 'daily', description: 'd' }, dir);

  // First tick acquires and (mid-run) a second tick fires. With SKIP policy
  // the second does nothing; the first appends its check-in unmolested.
  let secondSaw;
  const first = await withGoalLock('daily', async () => {
    secondSaw = await withGoalLock('daily', () => { appendCheckIn('daily', 'from-second', dir); }, { configDir: dir });
    appendCheckIn('daily', 'from-first', dir);
  }, { configDir: dir });

  assert.equal(first.skipped, false, 'outer tick ran');
  assert.equal(secondSaw.skipped, true, 'inner overlapping tick was skipped');
  const g = getGoal('daily', dir);
  assert.equal(g.checkIns.length, 1, 'only the holder wrote');
  assert.equal(g.checkIns[0].summary, 'from-first');
});

// ---------------------------------------------------------------------------
// (2) Budget guardrails on runLoop
// ---------------------------------------------------------------------------

function counter() {
  let n = 0;
  return {
    sendOnce: async () => { n += 1; return `reply-${n}`; },
    calls: () => n,
  };
}

test('runLoop: no budget = today\'s behavior (runs to --max, stoppedBy "max")', async () => {
  const c = counter();
  const r = await runLoop({ prompt: 'p', max: 3, until: null, messages: [], sendOnce: c.sendOnce });
  assert.equal(r.iterations, 3);
  assert.equal(r.stoppedBy, 'max');
  assert.equal(c.calls(), 3);
});

test('runLoop: max-tokens ceiling stops with stoppedBy "budget"', async () => {
  const c = counter();
  let tokens = 0;
  const r = await runLoop({
    prompt: 'p', max: 50, until: null, messages: [], sendOnce: async (m, s) => { tokens += 100; return c.sendOnce(m, s); },
    budget: { maxTokens: 250, getUsage: () => ({ tokens }) },
  });
  // Iters 1,2 push tokens to 100,200 (under 250). After iter 3 tokens=300 ≥ 250 → stop.
  assert.equal(r.stoppedBy, 'budget');
  assert.equal(r.iterations, 3, 'stops the iteration that crossed the token ceiling');
});

test('runLoop: max-cost ceiling stops with stoppedBy "budget"', async () => {
  const c = counter();
  let cost = 0;
  const r = await runLoop({
    prompt: 'p', max: 50, until: null, messages: [], sendOnce: async (m, s) => { cost += 0.4; return c.sendOnce(m, s); },
    budget: { maxCost: 1.0, getUsage: () => ({ cost }) },
  });
  assert.equal(r.stoppedBy, 'budget');
  assert.equal(r.iterations, 3, '0.4*3 = 1.2 ≥ 1.0 crosses on the third iteration');
});

test('runLoop: wall-clock timeout stops with stoppedBy "timeout" (virtual clock)', async () => {
  const c = counter();
  let t = 0;
  // now() advances 500ms each call; the loop checks pre- and post-iteration.
  const r = await runLoop({
    prompt: 'p', max: 50, until: null, messages: [], sendOnce: c.sendOnce,
    budget: { wallClockMs: 1000, now: () => { t += 500; return t; } },
  });
  assert.equal(r.stoppedBy, 'timeout', 'wall-clock cap surfaces as timeout');
  assert.ok(r.iterations >= 1 && r.iterations < 50, `stopped early, got ${r.iterations}`);
});

test('runLoop: global kill-switch stops immediately with stoppedBy "budget"', async () => {
  const c = counter();
  let killed = true; // kill before the first iteration
  const r = await runLoop({
    prompt: 'p', max: 50, until: null, messages: [], sendOnce: c.sendOnce,
    budget: { killSwitch: () => killed },
  });
  assert.equal(r.stoppedBy, 'budget');
  assert.equal(r.iterations, 0, 'kill-switch stops before any paid call');
  assert.equal(c.calls(), 0);
  killed = false; // sanity: with the switch off the same config runs
});

test('checkBudget: null budget and un-crossed ceilings return null', () => {
  assert.equal(checkBudget(null, 0), null);
  assert.equal(checkBudget({ maxTokens: 100, getUsage: () => ({ tokens: 50 }) }, 0), null);
  assert.equal(checkBudget({ wallClockMs: 1000, now: () => 500 }, 0), null);
});

// ---------------------------------------------------------------------------
// (backstop) patchGoal concurrent writers do not lose an update
// (pins the same-process invariant the singleton lock complements)
// ---------------------------------------------------------------------------

test('patchGoal: concurrent writers on the same goal do not lose an update', async () => {
  const dir = tmpDir();
  registerGoal({ name: 'proj', description: 'seed' }, dir);
  await Promise.all([
    patchGoal('proj', { description: 'from-A' }, dir),
    patchGoal('proj', { status: 'active', schedule: 'from-B' }, dir),
  ]);
  const g = getGoal('proj', dir);
  assert.equal(g.description, 'from-A');
  assert.equal(g.schedule, 'from-B');
});
