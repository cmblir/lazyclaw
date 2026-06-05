// Phase H2 — Cross-CLI confidence dampening (spec §0.1 H2, §3.5).
//
// trainer ≠ provider → confidence dampen by 0.85 (tunable).
// Phase B shipped the default-0.85 dampener; H2 adds the tunable factor
// so operators can dial it through `cfg.orchestra.learning.crossCliDampenFactor`
// without touching code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  crossCliDampen,
  computeConfidence,
  resolveDampenFactor,
  DEFAULT_CROSS_CLI_DAMPEN,
} from '../mas/confidence.mjs';

test('DEFAULT_CROSS_CLI_DAMPEN is 0.85 (spec §0.1 H2)', () => {
  assert.equal(DEFAULT_CROSS_CLI_DAMPEN, 0.85);
});

test('crossCliDampen: default factor still 0.85 when not specified', () => {
  assert.ok(Math.abs(crossCliDampen(1.0, 'claude-cli', 'codex-cli') - 0.85) < 1e-6);
});

test('crossCliDampen: factor=1.0 disables dampening', () => {
  assert.equal(crossCliDampen(0.8, 'claude-cli', 'codex-cli', 1.0), 0.8);
});

test('crossCliDampen: custom factor=0.5 halves cross-family score', () => {
  assert.ok(Math.abs(crossCliDampen(0.8, 'claude-cli', 'codex-cli', 0.5) - 0.4) < 1e-6);
});

test('crossCliDampen: same family ignores custom factor', () => {
  assert.equal(crossCliDampen(0.8, 'claude-cli', 'anthropic', 0.1), 0.8);
});

test('crossCliDampen: factor clamped into [0, 1]', () => {
  assert.equal(crossCliDampen(1.0, 'claude-cli', 'codex-cli', -0.5), 0);
  assert.equal(crossCliDampen(1.0, 'claude-cli', 'codex-cli', 2.5), 1.0);
});

test('crossCliDampen: NaN/invalid factor falls back to default 0.85', () => {
  assert.ok(Math.abs(crossCliDampen(1.0, 'claude-cli', 'codex-cli', NaN) - 0.85) < 1e-6);
  assert.ok(Math.abs(crossCliDampen(1.0, 'claude-cli', 'codex-cli', 'oops') - 0.85) < 1e-6);
});

test('computeConfidence: honors custom dampenFactor for cross family', () => {
  const same = computeConfidence({
    successes: 10, trials: 10, ageMs: 0,
    trainerProvider: 'claude-cli', workerProvider: 'anthropic',
    dampenFactor: 0.5,
  });
  const cross = computeConfidence({
    successes: 10, trials: 10, ageMs: 0,
    trainerProvider: 'claude-cli', workerProvider: 'codex-cli',
    dampenFactor: 0.5,
  });
  assert.ok(Math.abs(cross - same * 0.5) < 1e-5);
});

test('computeConfidence: dampenFactor=1.0 → no cross-family penalty', () => {
  const same = computeConfidence({
    successes: 10, trials: 10, ageMs: 0,
    trainerProvider: 'claude-cli', workerProvider: 'anthropic',
    dampenFactor: 1.0,
  });
  const cross = computeConfidence({
    successes: 10, trials: 10, ageMs: 0,
    trainerProvider: 'claude-cli', workerProvider: 'codex-cli',
    dampenFactor: 1.0,
  });
  assert.ok(Math.abs(cross - same) < 1e-6);
});

test('resolveDampenFactor: reads cfg.orchestra.learning.crossCliDampenFactor', () => {
  const cfg = { orchestra: { learning: { crossCliDampenFactor: 0.7 } } };
  assert.equal(resolveDampenFactor(cfg), 0.7);
});

test('resolveDampenFactor: legacy cfg.orchestrator.learning also honored', () => {
  const cfg = { orchestrator: { learning: { crossCliDampenFactor: 0.6 } } };
  assert.equal(resolveDampenFactor(cfg), 0.6);
});

test('resolveDampenFactor: missing/invalid config → default 0.85', () => {
  assert.equal(resolveDampenFactor(undefined), 0.85);
  assert.equal(resolveDampenFactor(null), 0.85);
  assert.equal(resolveDampenFactor({}), 0.85);
  assert.equal(resolveDampenFactor({ orchestra: {} }), 0.85);
  assert.equal(resolveDampenFactor({ orchestra: { learning: { crossCliDampenFactor: 'bad' } } }), 0.85);
});

test('resolveDampenFactor: clamps out-of-range values into [0, 1]', () => {
  assert.equal(resolveDampenFactor({ orchestra: { learning: { crossCliDampenFactor: -1 } } }), 0);
  assert.equal(resolveDampenFactor({ orchestra: { learning: { crossCliDampenFactor: 5 } } }), 1);
});
