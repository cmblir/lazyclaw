import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as gitTools from '../mas/tools/git.mjs';

function tmpRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lzc-git-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: d });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: d });
  fs.writeFileSync(path.join(d, 'a.txt'), 'hi\n');
  spawnSync('git', ['add', '.'], { cwd: d });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: d });
  return d;
}

test('exports 7 git tools', () => {
  const names = gitTools.TOOLS.map(t => t.name).sort();
  assert.deepEqual(names, ['git_blame','git_branch','git_commit','git_diff','git_log','git_push','git_status']);
});

test('git_status returns clean tree', async () => {
  const d = tmpRepo();
  const t = gitTools.TOOLS.find(t => t.name === 'git_status');
  const r = await t.exec({}, { cwd: d });
  assert.equal(r.ok, true);
  assert.match(r.stdout, /clean|nothing/);
});

test('git_log returns at least one commit', async () => {
  const d = tmpRepo();
  const t = gitTools.TOOLS.find(t => t.name === 'git_log');
  const r = await t.exec({ limit: 5 }, { cwd: d });
  assert.equal(r.ok, true);
  assert.ok(r.commits.length >= 1);
});

test('git_commit stages then commits', async () => {
  const d = tmpRepo();
  fs.writeFileSync(path.join(d, 'b.txt'), 'x');
  const t = gitTools.TOOLS.find(t => t.name === 'git_commit');
  const r = await t.exec({ message: 'add b', paths: ['b.txt'] }, { cwd: d });
  assert.equal(r.ok, true);
});

test('sensitivity matrix', () => {
  const m = Object.fromEntries(gitTools.TOOLS.map(t => [t.name, t.sensitive]));
  assert.equal(m.git_status, false);
  assert.equal(m.git_diff, false);
  assert.equal(m.git_log, false);
  assert.equal(m.git_blame, false);
  assert.equal(m.git_branch, false);
  assert.equal(m.git_commit, true);
  assert.equal(m.git_push, true);
});
