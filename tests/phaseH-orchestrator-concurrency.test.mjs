// Phase H — Orchestrator concurrency (C11).
//
// Spec §3 / canonical decision: the orchestrator's EXECUTE phase must
// honour cfg.orchestrator.concurrency. concurrency<=1 keeps the
// historical sequential streaming UX (live feedback). concurrency>=2
// dispatches subtasks via Promise.all and flushes their buffered
// chunks in PLAN ORDER so the user-facing output stays readable
// regardless of which worker finished first.
//
// Verification budget:
//   1. concurrency=3 with 3 subtasks of ~120ms each → total ~120ms,
//      NOT 360ms (parallel wall-clock).
//   2. concurrency=1 with 3 subtasks of ~120ms → ~360ms (sequential).
//   3. Output stream is plan-ordered even when worker 3 finishes
//      before worker 1.
//   4. One failing subtask doesn't block the others.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeOrchestratorProvider } from '../providers/orchestrator.mjs';
import { PROVIDERS, PROVIDER_INFO } from '../providers/registry.mjs';

// orchestrator no longer imports the registry (cycle broken); callers inject
// the provider lookup, exactly as registry.registerOrchestrator does.
const _lookup = (p) => ({ prov: PROVIDERS[p], info: PROVIDER_INFO[p] });

// Build a synthetic "delay-N" worker we register at the registry so
// the orchestrator's _lookupProvider picks it up the same way it would
// pick up claude-cli / openai / etc. Each worker yields a tagged chunk
// after `delayMs`. We patch PROVIDERS for the duration of the test and
// restore it on teardown.
function installDelayWorker(name, delayMs, opts = {}) {
  PROVIDERS[name] = {
    async *sendMessage(messages) {
      const t0 = Date.now();
      await new Promise((r) => setTimeout(r, delayMs));
      if (opts.throw) {
        throw new Error(opts.throw);
      }
      yield `[${name}] finished after ${Date.now() - t0}ms\n`;
    },
  };
  PROVIDER_INFO[name] = { defaultModel: 'fake' };
}

function removeWorker(name) {
  delete PROVIDERS[name];
  delete PROVIDER_INFO[name];
}

// Build a planner provider that emits a JSON array of N subtasks. We
// hand-craft the JSON so we don't need a real LLM call.
function installFakePlanner(subtasks) {
  PROVIDERS['fake-planner'] = {
    async *sendMessage() {
      yield JSON.stringify(subtasks);
    },
  };
  PROVIDER_INFO['fake-planner'] = { defaultModel: 'fake' };
}

async function drainStream(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(String(c));
  return chunks.join('');
}

test('C11 — concurrency=3 with 3 subtasks runs in parallel (~max wall-clock, not sum)', async () => {
  installFakePlanner([
    { id: 1, task: 'first',  rationale: 'A' },
    { id: 2, task: 'second', rationale: 'B' },
    { id: 3, task: 'third',  rationale: 'C' },
  ]);
  installDelayWorker('w1', 150);
  installDelayWorker('w2', 150);
  installDelayWorker('w3', 150);
  try {
    const cfg = {
      orchestrator: {
        planner: 'fake-planner',
        workers: ['w1', 'w2', 'w3'],
        concurrency: 3,
      },
    };
    const prov = makeOrchestratorProvider({ cfgGetter: () => cfg, lookup: _lookup });
    const t0 = Date.now();
    const out = await drainStream(prov.sendMessage(
      [{ role: 'user', content: 'do three things' }],
    ));
    const elapsed = Date.now() - t0;
    assert.ok(out.includes('parallel'), `header should mention parallel mode (got: ${out.slice(0, 200)})`);
    assert.ok(out.includes('Subtask 1'), 'subtask 1 present');
    assert.ok(out.includes('Subtask 2'), 'subtask 2 present');
    assert.ok(out.includes('Subtask 3'), 'subtask 3 present');
    // Parallel budget: total wall-clock must be less than 2× the
    // per-subtask delay. (Sum of three 150ms = 450ms; parallel ≈ 150ms.)
    // Generous upper bound to cope with CI jitter — we just need to
    // prove it's NOT sequential.
    assert.ok(elapsed < 320,
      `parallel run took ${elapsed}ms; expected <320ms for 3 × 150ms subtasks (would be ~450ms sequential)`);
  } finally {
    removeWorker('fake-planner');
    removeWorker('w1');
    removeWorker('w2');
    removeWorker('w3');
  }
});

test('C11 — concurrency=1 with 3 subtasks runs sequentially (~sum wall-clock)', async () => {
  installFakePlanner([
    { id: 1, task: 'first',  rationale: 'A' },
    { id: 2, task: 'second', rationale: 'B' },
    { id: 3, task: 'third',  rationale: 'C' },
  ]);
  installDelayWorker('w1', 120);
  try {
    const cfg = {
      orchestrator: {
        planner: 'fake-planner',
        workers: ['w1'],   // single worker → all 3 subtasks land here
        concurrency: 1,    // explicit sequential
      },
    };
    const prov = makeOrchestratorProvider({ cfgGetter: () => cfg, lookup: _lookup });
    const t0 = Date.now();
    const out = await drainStream(prov.sendMessage(
      [{ role: 'user', content: 'do three things' }],
    ));
    const elapsed = Date.now() - t0;
    // Header should NOT mention 'parallel' in sequential mode.
    assert.ok(!/concurrency=\d+, parallel/.test(out), 'sequential mode should not announce parallel');
    // Sequential budget: total ≥ ~3× per-subtask delay, minus generous
    // slack for fast machines.
    assert.ok(elapsed >= 300,
      `sequential run took ${elapsed}ms; expected ≥300ms for 3 × 120ms subtasks`);
  } finally {
    removeWorker('fake-planner');
    removeWorker('w1');
  }
});

test('C11 — parallel output is flushed in plan order regardless of finish order', async () => {
  installFakePlanner([
    { id: 1, task: 'slow',   rationale: 'first in plan' },
    { id: 2, task: 'medium', rationale: 'second' },
    { id: 3, task: 'fast',   rationale: 'third — finishes first' },
  ]);
  installDelayWorker('w-slow',   200);
  installDelayWorker('w-medium', 100);
  installDelayWorker('w-fast',    20);
  try {
    const cfg = {
      orchestrator: {
        planner: 'fake-planner',
        workers: ['w-slow', 'w-medium', 'w-fast'],
        concurrency: 3,
      },
    };
    const prov = makeOrchestratorProvider({ cfgGetter: () => cfg, lookup: _lookup });
    const out = await drainStream(prov.sendMessage(
      [{ role: 'user', content: 'check order' }],
    ));
    const idx1 = out.indexOf('Subtask 1');
    const idx2 = out.indexOf('Subtask 2');
    const idx3 = out.indexOf('Subtask 3');
    assert.ok(idx1 > -1 && idx2 > -1 && idx3 > -1, 'all subtasks present');
    assert.ok(idx1 < idx2, `plan order: Subtask 1 (${idx1}) must come before 2 (${idx2})`);
    assert.ok(idx2 < idx3, `plan order: Subtask 2 (${idx2}) must come before 3 (${idx3})`);
  } finally {
    removeWorker('fake-planner');
    removeWorker('w-slow');
    removeWorker('w-medium');
    removeWorker('w-fast');
  }
});

test('C11 — one failing subtask does not block the others', async () => {
  installFakePlanner([
    { id: 1, task: 'good',     rationale: 'will succeed' },
    { id: 2, task: 'failing',  rationale: 'will throw' },
    { id: 3, task: 'good too', rationale: 'will succeed' },
  ]);
  installDelayWorker('w-good', 50);
  installDelayWorker('w-bad',  50, { throw: 'boom: simulated worker failure' });
  installDelayWorker('w-also', 50);
  try {
    const cfg = {
      orchestrator: {
        planner: 'fake-planner',
        workers: ['w-good', 'w-bad', 'w-also'],
        concurrency: 3,
      },
    };
    const prov = makeOrchestratorProvider({ cfgGetter: () => cfg, lookup: _lookup });
    const out = await drainStream(prov.sendMessage(
      [{ role: 'user', content: 'mixed outcome' }],
    ));
    assert.ok(/worker error.*boom/i.test(out),
      `expected the failing worker's error to be surfaced inline; got: ${out.slice(0, 400)}`);
    assert.ok(out.includes('Subtask 1'), 'good subtask 1 still ran');
    assert.ok(out.includes('Subtask 3'), 'good subtask 3 still ran');
  } finally {
    removeWorker('fake-planner');
    removeWorker('w-good');
    removeWorker('w-bad');
    removeWorker('w-also');
  }
});

test('E1 — concurrency bounds the parallel fan-out (4 subtasks, pool of 2 → ~2 batches)', async () => {
  // The parallel path used to Promise.all over EVERY subtask at once,
  // ignoring cfg.orchestrator.concurrency for batching — so a large plan
  // could fire N simultaneous provider calls and over-subscribe rate
  // limits / memory. With a bounded pool, 4 subtasks at concurrency=2 run
  // in two batches: wall-clock ≈ 2 × per-subtask, NOT 1× (unbounded) and
  // NOT 4× (sequential).
  installFakePlanner([
    { id: 1, task: 'a', rationale: 'A' },
    { id: 2, task: 'b', rationale: 'B' },
    { id: 3, task: 'c', rationale: 'C' },
    { id: 4, task: 'd', rationale: 'D' },
  ]);
  installDelayWorker('w1', 150);
  installDelayWorker('w2', 150);
  try {
    const cfg = {
      orchestrator: {
        planner: 'fake-planner',
        workers: ['w1', 'w2'],
        concurrency: 2,
      },
    };
    const prov = makeOrchestratorProvider({ cfgGetter: () => cfg, lookup: _lookup });
    const t0 = Date.now();
    const out = await drainStream(prov.sendMessage(
      [{ role: 'user', content: 'do four things' }],
    ));
    const elapsed = Date.now() - t0;
    assert.ok(out.includes('parallel'), 'header should mention parallel mode');
    for (const n of [1, 2, 3, 4]) {
      assert.ok(out.includes(`Subtask ${n}`), `subtask ${n} present`);
    }
    // 4 × 150ms in a pool of 2 → ~300ms. >250ms rules out the old
    // all-at-once behaviour (~150ms); <520ms rules out sequential (~600ms).
    assert.ok(elapsed >= 250 && elapsed < 520,
      `bounded run took ${elapsed}ms; expected ~300ms (2 batches of 150ms), not ~150ms (unbounded) or ~600ms (sequential)`);
  } finally {
    removeWorker('fake-planner');
    removeWorker('w1');
    removeWorker('w2');
  }
});
