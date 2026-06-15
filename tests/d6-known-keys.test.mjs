// tests/d6-known-keys.test.mjs — config validate must recognize the first-class
// model-bearing keys (trainer / orchestrator / persona / customProviders / chat)
// instead of reporting them as "unknown top-level key".

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../config-validate.mjs';

test('trainer + orchestrator are recognized top-level keys', () => {
  const providers = { mock: {} };
  const res = validateConfig(
    { provider: 'mock', trainer: { provider: 'auto' }, orchestrator: { workers: [] } },
    providers,
  );
  const warn = res.warnings.join('\n');
  assert.ok(!/unknown top-level key: trainer/.test(warn), 'trainer must be known');
  assert.ok(!/unknown top-level key: orchestrator/.test(warn), 'orchestrator must be known');
});

test('a genuinely unknown key still warns', () => {
  const res = validateConfig({ bogusKey: 1 }, { mock: {} });
  assert.ok(/unknown top-level key: bogusKey/.test(res.warnings.join('\n')));
});
