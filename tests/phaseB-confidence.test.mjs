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

test('computeConfidence: composes Wilson + decay + dampen', () => {
  const same = computeConfidence({ successes: 10, trials: 10, ageMs: 0, trainerProvider: 'claude-cli', workerProvider: 'anthropic' });
  const cross = computeConfidence({ successes: 10, trials: 10, ageMs: 0, trainerProvider: 'claude-cli', workerProvider: 'codex-cli' });
  assert.ok(Math.abs(cross - same * 0.85) < 1e-5);
});
