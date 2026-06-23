import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWizardSteps } from '../tui/wizard_back.mjs';

test('runs all steps in order when each advances', async () => {
  const seen = [];
  const r = await runWizardSteps(['a', 'b', 'c'], (id) => { seen.push(id); return 'NEXT'; });
  assert.equal(r, 'DONE');
  assert.deepEqual(seen, ['a', 'b', 'c']);
});

test('BACK re-runs the previous step (one step back)', async () => {
  const seen = [];
  // a→b, b→BACK (back to a), a→NEXT, b→NEXT, c→NEXT
  const script = { a: ['NEXT', 'NEXT'], b: ['BACK', 'NEXT'], c: ['NEXT'] };
  const r = await runWizardSteps(['a', 'b', 'c'], (id) => { seen.push(id); return script[id].shift(); });
  assert.equal(r, 'DONE');
  assert.deepEqual(seen, ['a', 'b', 'a', 'b', 'c']);
});

test('Esc on the first step stays on it (nothing before)', async () => {
  let aRuns = 0;
  const r = await runWizardSteps(['a', 'b'], (id) => {
    if (id === 'a') { aRuns += 1; return aRuns === 1 ? 'BACK' : 'NEXT'; }
    return 'NEXT';
  });
  assert.equal(r, 'DONE');
  assert.equal(aRuns, 2, 'first step re-runs after its own Esc, not exits');
});

test('CANCEL aborts the whole group', async () => {
  const seen = [];
  const r = await runWizardSteps(['a', 'b', 'c'], (id) => { seen.push(id); return id === 'b' ? 'CANCEL' : 'NEXT'; });
  assert.equal(r, 'CANCEL');
  assert.deepEqual(seen, ['a', 'b']);
});
