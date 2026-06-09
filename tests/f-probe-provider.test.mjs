// tests/f-probe-provider.test.mjs — probeProvider must return a result and
// NEVER call process.exit. Regression: the setup wizard's verify step called
// `cmdProviders('test')`, which exits the process; after the verify step was
// moved up to Step 2, that exit killed the rest of the wizard (Steps 3-6).
// The no-exit probe fixes it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureRegistry } from '../lib/registry_boot.mjs';
import { probeProvider } from '../providers/probe.mjs';

test('probeProvider returns a result for a known provider (mock) without exiting', async () => {
  await ensureRegistry();
  const r = await probeProvider({ name: 'mock', model: 'test-model' });
  assert.equal(r.provider, 'mock');
  assert.equal(r.model, 'test-model');
  assert.equal(typeof r.ok, 'boolean');
  assert.ok(Number.isFinite(r.durationMs), 'durationMs is a number');
  // Reaching this line at all proves probeProvider did not process.exit.
});

test('probeProvider on an unknown provider returns ok:false (no throw, no exit)', async () => {
  await ensureRegistry();
  const r = await probeProvider({ name: 'definitely-not-a-provider', model: 'm' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNKNOWN_PROVIDER');
  assert.match(r.error || '', /unknown provider/);
});

test('providers test branch + setup verify both import the shared probe (no inline process.exit in setup verify)', async () => {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const path = await import('node:path');
  const root = path.dirname(url.fileURLToPath(import.meta.url)) + '/..';
  const setupSrc = fs.readFileSync(root + '/commands/setup.mjs', 'utf8');
  assert.match(setupSrc, /probeProvider/, 'setup wizard must use probeProvider');
  assert.doesNotMatch(setupSrc, /cmdProviders\(\s*'test'/, 'setup wizard must not call the exiting cmdProviders test path');
});
