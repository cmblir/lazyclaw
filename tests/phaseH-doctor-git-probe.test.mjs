// Phase H — Doctor git probe (C12).
//
// `lazyclaw doctor` MUST detect a missing git binary up front. On
// stripped Windows PATHs (no Git-for-Windows) or minimal Docker base
// images, the git tool spawnSyncs ENOENT silently and any agent task
// touching git fails opaquely. The probe should:
//   1. Surface a `NO_GIT` style issue when `git --version` ENOENTs.
//   2. Return git=ok=true and the version string when git is present.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = process.cwd();
const CLI = path.join(REPO_ROOT, 'cli.mjs');

function tmpCfg(prefix = 'lc-doctor-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args, cfgDir, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir, ...env },
  });
}

test('C12 — doctor reports git probe ok=true when git is on PATH', () => {
  const dir = tmpCfg();
  // Make a minimal valid config so doctor doesn't bail on missing fields.
  runCli(['config', 'set', 'provider', 'mock'], dir);

  const r = runCli(['doctor'], dir);
  // doctor exits non-zero when issues[] is non-empty; we don't care
  // about that here — we only assert the git block shape.
  const out = JSON.parse(r.stdout);
  assert.ok(out.git, 'doctor output should include a `git` block');
  // CI machines have git; if a developer is somehow running without it
  // they'll see this fail and learn — that's also valid signal.
  if (out.git.ok) {
    assert.match(out.git.version || '', /git version /i,
      `expected git version string; got: ${JSON.stringify(out.git)}`);
  } else {
    // Useful diagnostic for someone running the test without git.
    assert.fail(`expected git ok on the test host; got: ${JSON.stringify(out.git)}`);
  }
});

test('C12 — doctor surfaces NO_GIT issue when git binary is missing (PATH override)', () => {
  const dir = tmpCfg();
  runCli(['config', 'set', 'provider', 'mock'], dir);

  // Force `git --version` to fail by pointing PATH at an empty dir.
  // On macOS / Linux this reliably yields ENOENT from spawnSync('git').
  const emptyPathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-empty-path-'));
  const r = runCli(['doctor'], dir, {
    PATH: emptyPathDir,
    // Clear any explicit override so our PATH manipulation actually bites.
    GIT_EXECUTABLE: '',
  });
  const out = JSON.parse(r.stdout);
  assert.ok(out.git, 'doctor output should include a `git` block');
  assert.equal(out.git.ok, false,
    `expected git.ok=false with empty PATH; got: ${JSON.stringify(out.git)}`);
  // The issue array must include a NO_GIT-style entry the user can grep for.
  const hasIssue = Array.isArray(out.issues) && out.issues.some(
    (m) => /git binary not found|GIT_NOT_INSTALLED|NO_GIT/i.test(String(m)),
  );
  assert.ok(hasIssue,
    `issues[] should mention the missing git binary; got: ${JSON.stringify(out.issues)}`);
});

test('C12 — doctor includes an `index` block reporting recent index failures', () => {
  const dir = tmpCfg();
  runCli(['config', 'set', 'provider', 'mock'], dir);

  // No prior failures — the block should be present with zeros.
  const r1 = runCli(['doctor'], dir);
  const o1 = JSON.parse(r1.stdout);
  assert.ok(o1.index, 'doctor output should include an `index` block');
  assert.equal(o1.index.failuresLast24h, 0);

  // Seed a synthetic failure entry and re-run doctor — must report 1.
  const failFile = path.join(dir, 'index-failures.jsonl');
  fs.writeFileSync(failFile, JSON.stringify({
    ts: new Date().toISOString(),
    event: 'index.write.failed',
    scope: 'skills',
    error: 'synthetic test entry',
  }) + '\n');
  const r2 = runCli(['doctor'], dir);
  const o2 = JSON.parse(r2.stdout);
  assert.equal(o2.index.failuresLast24h, 1,
    `expected 1 recent failure; got: ${JSON.stringify(o2.index)}`);
  // And the issues[] should mention it so the operator sees a hint.
  const hasIndexIssue = Array.isArray(o2.issues) && o2.issues.some(
    (m) => /index write failure/i.test(String(m)),
  );
  assert.ok(hasIndexIssue,
    `issues[] should mention the index failure; got: ${JSON.stringify(o2.issues)}`);
});
