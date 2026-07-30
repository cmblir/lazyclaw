// tests/f-config-validate-known-keys.test.mjs
//
// validateConfig's KNOWN_KEYS set listed only 9 top-level keys, so a dozen
// keys that the rest of the codebase actually reads (sandbox, channels, cron,
// pairing, auth profiles, mcp, …) were false-flagged as "unknown top-level
// key" warnings on a perfectly valid config. These pin that the real keys pass
// clean while a genuinely unknown key is still reported.

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../config-validate.mjs';

test('known top-level config keys are not flagged as unknown', () => {
  const cfg = {
    provider: 'mock',
    sandbox: {}, pairing: [], channels: {}, authProfiles: {}, authActiveProfile: 'x',
    nodes: {}, messaging: {}, cron: {}, mcp: {}, orchestra: {}, security: {}, skills: [], workspace: 'w',
    recall: { embeddings: { enabled: false } }, workflows: {},
    gateway: { port: 19600 }, dashboard: { port: 19601 }, daemon: { port: 19602 },
  };
  const r = validateConfig(cfg, { mock: {} });
  const unknown = r.warnings.filter((w) => /unknown top-level key/.test(w));
  assert.deepEqual(unknown, [], `no real key should be flagged: ${unknown.join('; ')}`);
});

test('a genuinely unknown key is still flagged', () => {
  const r = validateConfig({ provider: 'mock', bogusKey: 1 }, { mock: {} });
  assert.ok(r.warnings.some((w) => /unknown top-level key: bogusKey/.test(w)),
    'an unrecognised key must still warn');
});
