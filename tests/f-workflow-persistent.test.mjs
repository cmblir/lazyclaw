// tests/f-workflow-persistent.test.mjs
//
// Roadmap B-5 — a declarative workflow can run persisted + resumable (opts.
// sessionId). The subtle correctness guard: the {{ref}} bag is closed over the
// compiled nodes, so on resume the SKIPPED (already-succeeded) nodes never
// repopulate it — runDeclarativePersistent pre-seeds the bag from the prior
// state's success outputs, or a downstream {{ref}} would resolve to undefined.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDeclarativeRequest } from '../workflow/run_request.mjs';
import { saveState, statePath } from '../workflow/persistent.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaw-wfp-'));

test('a fresh persistent run completes and writes state', async () => {
  const dir = tmp();
  const def = { nodes: [{ id: 'x', type: 'set', config: { value: 42 } }] };
  const out = await runDeclarativeRequest(def, {}, { sessionId: 'fresh1', dir });
  assert.equal(out.success, true);
  assert.equal(out.session.x, 42);
  assert.equal(out.sessionId, 'fresh1');
  assert.ok(fs.existsSync(statePath('fresh1', dir)), 'state file written');
});

test('resume preseeds the {{ref}} bag from prior success outputs', async () => {
  const dir = tmp();
  const sessionId = 'sess1';
  const def = {
    nodes: [
      { id: 'a', type: 'set', config: { value: 'FRESH' } },
      { id: 'b', type: 'template', config: { text: 'got: {{a}}' } },
    ],
  };
  // Craft a prior state: `a` already succeeded (output 'PRIOR'), `b` pending.
  saveState({
    sessionId, order: ['a', 'b'],
    nodes: { a: { status: 'success', output: 'PRIOR', attempts: 1 }, b: { status: 'pending', attempts: 0 } },
    startedAt: 1, updatedAt: 1,
  }, dir);

  const out = await runDeclarativeRequest(def, {}, { sessionId, dir });
  assert.equal(out.success, true);
  assert.equal(out.session.a, 'PRIOR', 'a was NOT re-run (kept the prior state output, not FRESH)');
  assert.equal(out.session.b, 'got: PRIOR', 'b resolved {{a}} from the PRE-SEEDED bag, not undefined');
  assert.deepEqual(out.executedNodes, ['b'], 'only b executed on resume');
});

test('re-running a completed session returns the persisted session without re-execution', async () => {
  const dir = tmp();
  const def = {
    nodes: [
      { id: 'a', type: 'set', config: { value: 'one' } },
      { id: 'b', type: 'template', config: { text: '{{a}}-two' } },
    ],
  };
  await runDeclarativeRequest(def, {}, { sessionId: 's2', dir }); // run 1
  const out = await runDeclarativeRequest(def, {}, { sessionId: 's2', dir }); // resume — all done
  assert.equal(out.success, true);
  assert.equal(out.session.b, 'one-two');
  assert.deepEqual(out.executedNodes, [], 'nothing re-executed on a completed session');
});
