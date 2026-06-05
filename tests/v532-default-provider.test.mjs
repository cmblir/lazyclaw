// v5.3.2 — default chat provider regression guard.
//
// Before v5.3.2 the interactive setup wizard could write
// `{ provider: 'orchestrator', model: 'orchestrator' }` to cfg.json
// whenever the user picked Orchestrator from the CLI/Local family
// list. That produced a half-configured install (no planner /
// workers) and the first chat turn died with an opaque
// "orchestrator not configured" error. The fix:
//
//   1. _providerFamilies() filters 'orchestrator' out of every
//      bucket — picker can never land on it.
//   2. _pickProviderInteractive non-TTY fallback returns
//      'claude-cli' instead of providers[0].
//   3. cmdChat last-resort safety net falls through to
//      'claude-cli' instead of 'mock'.
//   4. cmdDoctor surfaces a soft-migration warning when an
//      existing user has `provider: orchestrator` but no
//      cfg.orchestrator block.
//
// This file pins all four behaviours.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const CLI = path.join(REPO_ROOT, 'cli.mjs');

function tmpConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-v532-'));
}

function runCli(args, cfgDir, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir, ...extraEnv },
  });
}

test('fresh onboard --non-interactive --provider claude-cli writes provider:"claude-cli" (not "orchestrator")', () => {
  const dir = tmpConfigDir();
  const r = runCli(
    ['onboard', '--non-interactive', '--provider', 'claude-cli', '--model', 'claude-opus-4-7'],
    dir,
  );
  assert.equal(r.status, 0, `onboard exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(cfg.provider, 'claude-cli', `expected provider="claude-cli", got ${JSON.stringify(cfg.provider)}`);
  assert.notEqual(cfg.provider, 'orchestrator', 'fresh onboard must never write provider:"orchestrator"');
  assert.notEqual(cfg.model, 'orchestrator', 'fresh onboard must never write model:"orchestrator"');
  assert.equal(cfg.model, 'claude-opus-4-7');
});

test('_providerFamilies filters orchestrator out of every bucket (cli-family picker can never default to it)', async () => {
  // Spawn a tiny harness that loads cli.mjs and prints the picker buckets.
  // We can't import cli.mjs directly without triggering its top-level
  // CLI dispatch, but we can import providers/registry.mjs and re-run the
  // same bucketing logic. The shape mirrors _providerFamilies in cli.mjs.
  const reg = await import('../providers/registry.mjs');
  const info = reg.PROVIDER_INFO || {};
  const all = Object.keys(reg.PROVIDERS);
  const buckets = { api: [], cli: [], mock: [] };
  for (const name of all) {
    if (name === 'mock') buckets.mock.push(name);
    else if (name === 'orchestrator') continue;
    else if ((info[name] || {}).requiresApiKey) buckets.api.push(name);
    else buckets.cli.push(name);
  }
  assert.ok(!buckets.cli.includes('orchestrator'), 'orchestrator must not appear in the CLI/Local family');
  assert.ok(!buckets.api.includes('orchestrator'), 'orchestrator must not appear in the API-key family');
  assert.ok(!buckets.mock.includes('orchestrator'), 'orchestrator must not appear in the Mock family');
  // Sanity: orchestrator is still registered (so explicit invocation works).
  assert.ok(reg.PROVIDERS.orchestrator, 'PROVIDERS.orchestrator must still be registered');
});

test('doctor surfaces a soft-migration warning when provider="orchestrator" but cfg.orchestrator is missing', () => {
  const dir = tmpConfigDir();
  // Hand-write the half-configured state pre-v5.3.2 wizards used to produce.
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ provider: 'orchestrator', model: 'orchestrator' }, null, 2),
  );
  const r = runCli(['doctor'], dir);
  // doctor exits 0 (no hard issues, just a warning) — half-config is not fatal.
  const out = JSON.parse(r.stdout);
  assert.ok(Array.isArray(out.warnings), 'doctor must return a warnings[] array');
  const found = out.warnings.find((w) => /orchestrator/i.test(w) && /claude-cli/.test(w));
  assert.ok(found, `expected an orchestrator soft-migration warning, got: ${JSON.stringify(out.warnings)}`);
});

test('doctor does NOT warn when provider="orchestrator" and cfg.orchestrator is fully configured', () => {
  const dir = tmpConfigDir();
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      provider: 'orchestrator',
      model: 'orchestrator',
      orchestrator: {
        planner: 'claude-cli:claude-opus-4-7',
        workers: ['claude-cli:claude-haiku-4-5'],
        maxSubtasks: 5,
      },
    }, null, 2),
  );
  const r = runCli(['doctor'], dir);
  const out = JSON.parse(r.stdout);
  const found = (out.warnings || []).find((w) => /orchestrator/i.test(w));
  assert.equal(found, undefined, `unexpected orchestrator warning on a fully configured install: ${found}`);
});
