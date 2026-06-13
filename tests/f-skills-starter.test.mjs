// tests/f-skills-starter.test.mjs — `lazyclaw skills starter` installs the
// bundled starter pack (repo skills/ dir) into <configDir>/skills/, skips
// names that already exist, and only overwrites with --force.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = process.cwd();
const CLI = path.join(REPO_ROOT, 'cli.mjs');

function tmpCfg() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-skills-starter-'));
}

function runCli(args, cfgDir) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir },
  });
}

test('skills starter installs the bundled pack with frontmatter intact', () => {
  const dir = tmpCfg();
  const r = runCli(['skills', 'starter'], dir);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.ok(out.installed.length >= 5, `expected ≥5 starter skills, got ${out.installed.length}`);
  assert.equal(out.skipped.length, 0, 'fresh config dir skips nothing');
  for (const s of out.installed) {
    const p = path.join(dir, 'skills', `${s.name}.md`);
    assert.ok(fs.existsSync(p), `${s.name} written to skills/`);
    assert.match(fs.readFileSync(p, 'utf8'), /^---\r?\n/, `${s.name} keeps its frontmatter`);
  }
});

test('skills starter pack is listable with non-empty summaries', () => {
  const dir = tmpCfg();
  runCli(['skills', 'starter'], dir);
  const r = runCli(['skills', 'list'], dir);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const items = JSON.parse(r.stdout);
  assert.ok(items.length >= 5);
  for (const it of items) {
    assert.ok(it.summary && it.summary.length > 0, `${it.name} has a summary for the recall index`);
  }
});

test('re-run skips existing skills; --force overwrites them', () => {
  const dir = tmpCfg();
  const first = runCli(['skills', 'starter'], dir);
  const installed = JSON.parse(first.stdout).installed;
  const victim = installed[0].name;
  const victimPath = path.join(dir, 'skills', `${victim}.md`);
  fs.writeFileSync(victimPath, 'user edited — must survive a plain re-run');

  const second = runCli(['skills', 'starter'], dir);
  assert.equal(second.status, 0, `stderr=${second.stderr}`);
  const out2 = JSON.parse(second.stdout);
  assert.equal(out2.installed.length, 0, 're-run installs nothing new');
  assert.ok(out2.skipped.some((s) => s.name === victim), 'edited skill reported as skipped');
  assert.equal(fs.readFileSync(victimPath, 'utf8'), 'user edited — must survive a plain re-run');

  const third = runCli(['skills', 'starter', '--force'], dir);
  assert.equal(third.status, 0, `stderr=${third.stderr}`);
  const out3 = JSON.parse(third.stdout);
  assert.ok(out3.installed.some((s) => s.name === victim), '--force reinstalls the edited skill');
  assert.match(fs.readFileSync(victimPath, 'utf8'), /^---\r?\n/, 'bundled content restored');
});
