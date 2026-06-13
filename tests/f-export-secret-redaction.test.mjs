// tests/f-export-secret-redaction.test.mjs — SECURITY regression: `lazyclaw
// export` promises secrets are redacted unless --include-secrets, but the
// pre-fix code only masked cfg['api-key']. It left
// cfg.authProfiles[<provider>] = [{ label, key }] (per-provider keys written
// by providers/auth_store.mjs) and any other secret-bearing config key fully
// exposed in the JSON bundle. These tests pin: no-flag export must contain
// NONE of the secret values (but keep labels/structure), and --include-secrets
// must export everything verbatim.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = process.cwd();
const CLI = path.join(REPO_ROOT, 'cli.mjs');

const API_KEY_SECRET = 'sk-TOPLEVEL-APIKEY-0001';
const PROFILE_SECRET = 'sk-SECRET123';
const NESTED_SECRET = 'tok-NESTED-9999';

function tmpCfg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-export-redact-'));
  const cfg = {
    'api-key': API_KEY_SECRET,
    provider: 'anthropic',
    model: 'opus',
    baseUrl: 'https://api.example.com',
    authActiveProfile: { anthropic: 'default' },
    authProfiles: {
      anthropic: [{ label: 'default', key: PROFILE_SECRET }],
    },
    // A custom nested secret-bearing key the defensive deep-redact must catch.
    integrations: { webhook: { secret: NESTED_SECRET } },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
  return dir;
}

function runCli(args, cfgDir) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir },
  });
}

test('export (no flag) redacts every secret value but keeps labels/structure', () => {
  const dir = tmpCfg();
  const r = runCli(['export'], dir);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);

  // No secret VALUE may appear anywhere in the serialized bundle.
  assert.ok(!r.stdout.includes(API_KEY_SECRET), 'top-level api-key value leaked');
  assert.ok(!r.stdout.includes(PROFILE_SECRET), 'authProfiles key value leaked');
  assert.ok(!r.stdout.includes(NESTED_SECRET), 'nested custom secret value leaked');

  const bundle = JSON.parse(r.stdout);
  assert.equal(bundle.secretsIncluded, false);
  // Structure/labels are preserved so the bundle stays inspectable.
  assert.equal(bundle.config['api-key'], '***REDACTED***');
  assert.equal(bundle.config.authProfiles.anthropic[0].label, 'default');
  assert.equal(bundle.config.authProfiles.anthropic[0].key, '***REDACTED***');
  assert.equal(bundle.config.integrations.webhook.secret, '***REDACTED***');
  // Non-secret keys must NOT be touched.
  assert.equal(bundle.config.baseUrl, 'https://api.example.com');
  assert.equal(bundle.config.model, 'opus');
  assert.equal(bundle.config.authActiveProfile.anthropic, 'default');
});

test('importing a redacted bundle never persists the ***REDACTED*** placeholder', () => {
  // Reciprocal of the export redaction: a redacted bundle must not write the
  // literal placeholder into config.json (pre-fix cmdImport only stripped the
  // top-level api-key, leaving '***REDACTED***' in authProfiles[].key and
  // nested secret keys).
  const srcDir = tmpCfg();
  const exp = runCli(['export'], srcDir);
  assert.equal(exp.status, 0, `export failed: ${exp.stderr}`);

  const dstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-import-redact-'));
  const imp = spawnSync(process.execPath, [CLI, 'import'], {
    input: exp.stdout,
    encoding: 'utf8',
    env: { ...process.env, LAZYCLAW_CONFIG_DIR: dstDir },
  });
  assert.equal(imp.status, 0, `import failed: ${imp.stderr}`);

  const written = fs.readFileSync(path.join(dstDir, 'config.json'), 'utf8');
  assert.ok(!written.includes('***REDACTED***'), 'placeholder must never be persisted to config.json');

  const cfg = JSON.parse(written);
  // The redacted key is dropped, not written as a literal — and the profile
  // slot keeps its label so the structure survives.
  assert.equal(cfg['api-key'], undefined, 'redacted top-level api-key must be dropped, not literal');
  assert.equal(cfg.authProfiles.anthropic[0].label, 'default', 'profile label survives');
  assert.equal(cfg.authProfiles.anthropic[0].key, undefined, 'redacted profile key dropped, not literal');
  assert.equal(cfg.integrations.webhook.secret, undefined, 'redacted nested secret dropped, not literal');
  // Non-secret values still import normally.
  assert.equal(cfg.baseUrl, 'https://api.example.com');
});

test('export --include-secrets exports every secret verbatim', () => {
  const dir = tmpCfg();
  const r = runCli(['export', '--include-secrets'], dir);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
  assert.ok(r.stdout.includes(API_KEY_SECRET), 'top-level api-key must be present');
  assert.ok(r.stdout.includes(PROFILE_SECRET), 'authProfiles key must be present');
  assert.ok(r.stdout.includes(NESTED_SECRET), 'nested secret must be present');

  const bundle = JSON.parse(r.stdout);
  assert.equal(bundle.secretsIncluded, true);
  assert.equal(bundle.config.authProfiles.anthropic[0].key, PROFILE_SECRET);
});
