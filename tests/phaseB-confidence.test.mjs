// Phase B: confidence calculator (spec §0.1 H2, §3.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wilsonLowerBound, crossCliDampen, computeConfidence } from '../mas/confidence.mjs';

test('wilsonLowerBound: zero trials returns 0', () => {
  assert.equal(wilsonLowerBound(0, 0), 0);
});

test('wilsonLowerBound: 10/10 successes is high but < 1', () => {
  const lb = wilsonLowerBound(10, 10);
  assert.ok(lb > 0.7, `expected >0.7, got ${lb}`);
  assert.ok(lb < 1, `expected <1, got ${lb}`);
});

test('wilsonLowerBound: 0/10 successes is near 0', () => {
  assert.ok(wilsonLowerBound(0, 10) < 0.05);
});

test('wilsonLowerBound: more trials at 100% raises the bound', () => {
  assert.ok(wilsonLowerBound(100, 100) > wilsonLowerBound(10, 10));
});

test('crossCliDampen: same family is identity', () => {
  assert.ok(Math.abs(crossCliDampen(0.8, 'claude-cli', 'anthropic') - 0.8) < 1e-6);
  assert.ok(Math.abs(crossCliDampen(0.5, 'codex-cli', 'openai') - 0.5) < 1e-6);
});

test('crossCliDampen: cross-family multiplies by 0.85', () => {
  assert.ok(Math.abs(crossCliDampen(1.0, 'claude-cli', 'codex-cli') - 0.85) < 1e-6);
  assert.ok(Math.abs(crossCliDampen(0.4, 'gemini-cli', 'anthropic') - 0.34) < 1e-6);
});

test('computeConfidence: a fresh 1/1 skill is stamped above the 0.3 archive floor', () => {
  // The old code stamped wilsonLowerBound(1,1)=0.206 — below the 0.3 archive
  // floor — so a brand-new skill from one successful task was deleted on its
  // first active-recall miss. Use the Beta(1,1) posterior mean for small n.
  const c = computeConfidence({ successes: 1, trials: 1 });
  assert.ok(c > 0.3, `fresh skill must sit above the 0.3 archive floor, got ${c}`);
  assert.ok(Math.abs(c - 2 / 3) < 1e-6, `expected the Laplace prior (1+1)/(1+2)=0.667, got ${c}`);
});

test('computeConfidence: a fresh 1/1 skill survives one -0.1 recall-miss decrement', () => {
  const c = computeConfidence({ successes: 1, trials: 1 });
  assert.ok(c - 0.1 >= 0.3, `fresh skill must survive one recall miss, got ${c - 0.1}`);
});

test('computeConfidence: a fresh 0/1 (failed) skill stays low and archives on the first miss', () => {
  const c = computeConfidence({ successes: 0, trials: 1 });
  assert.ok(Math.abs(c - 1 / 3) < 1e-6, `expected (0+1)/(1+2)=0.333, got ${c}`);
  assert.ok(c - 0.1 < 0.3, 'a failed fresh skill should archive on the first miss');
});

test('computeConfidence: switches to the Wilson lower bound once trials >= minTrials', () => {
  const c = computeConfidence({ successes: 3, trials: 3 });
  assert.ok(Math.abs(c - wilsonLowerBound(3, 3)) < 1e-6, `expected Wilson at n>=3, got ${c}`);
});

test('computeConfidence: composes Wilson + decay + dampen', () => {
  const same = computeConfidence({ successes: 10, trials: 10, ageMs: 0, trainerProvider: 'claude-cli', workerProvider: 'anthropic' });
  const cross = computeConfidence({ successes: 10, trials: 10, ageMs: 0, trainerProvider: 'claude-cli', workerProvider: 'codex-cli' });
  assert.ok(Math.abs(cross - same * 0.85) < 1e-5);
});
