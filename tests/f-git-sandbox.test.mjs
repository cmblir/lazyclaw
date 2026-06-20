// f-git-sandbox — a configured sandbox spec must reach the git_* tools.
//
// CAPABILITY-ONLY: no caller threads ctx.sandbox yet, so absent-sandbox runs
// take the bare spawnSync path and remain byte-identical. These tests pin the
// injection seam (mirroring f-coding-sandbox.test.mjs / f-sandbox-application):
//   - ctx.sandbox=<spec> → routed through spawnSyncSandboxed (injected seam)
//   - ctx without sandbox → bare path, the fake is NEVER invoked
//
// Tests are host-independent: routing is asserted via the injected fake, so no
// real git binary is required (the fake returns a synthetic spawnSync result).

import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../mas/tools/git.mjs';

const git_status = TOOLS.find((t) => t.name === 'git_status');
const git_commit = TOOLS.find((t) => t.name === 'git_commit');

test('git_status routes through the injected sync sandbox spawner exactly once', async () => {
  const calls = [];
  const spec = { kind: 'local', confiner: 'none' };
  const fake = (s, bin, args, opts) => {
    calls.push({ s, bin, args, opts });
    return { status: 0, stdout: 'clean', stderr: '' };
  };
  const r = await git_status.exec(
    {},
    { cwd: '/x', sandbox: spec, _spawnSyncSandboxed: fake }
  );
  assert.equal(r.ok, true);
  assert.equal(r.stdout, 'clean');
  assert.equal(calls.length, 1, 'spawnSyncSandboxed must be called exactly once');
  assert.equal(calls[0].s, spec, 'the spec must be passed through by identity');
  assert.equal(calls[0].bin, process.env.GIT_EXECUTABLE || 'git', 'bin must be the git executable');
  assert.deepEqual(calls[0].args, ['status'], 'args must be the git subcommand');
  assert.equal(calls[0].opts.cwd, '/x');
  assert.equal(calls[0].opts.encoding, 'utf8', 'a utf8 encoding must still be applied');
});

test('git_status with NO sandbox takes the bare path (never calls the fake)', async () => {
  let called = false;
  const fake = () => { called = true; return { status: 0, stdout: '', stderr: '' }; };
  // No sandbox in ctx → must take the bare spawnSync branch. Point at a
  // guaranteed-missing binary so the bare path resolves fast and host-free.
  await git_status.exec(
    {},
    { cwd: '/x', _spawnSyncSandboxed: fake }
  );
  assert.equal(called, false, 'absent sandbox must NOT route through spawnSyncSandboxed');
});

test('git_commit (write tool) also routes through the fake when a sandbox is present', async () => {
  const calls = [];
  const spec = { kind: 'local', confiner: 'none' };
  const fake = (s, bin, args, opts) => {
    calls.push({ s, bin, args, opts });
    return { status: 0, stdout: '', stderr: '' };
  };
  const r = await git_commit.exec(
    { message: 'msg' },
    { cwd: '/x', sandbox: spec, _spawnSyncSandboxed: fake }
  );
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1, 'the commit path must thread the seam exactly once');
  assert.equal(calls[0].s, spec, 'the spec must be passed through by identity');
  assert.deepEqual(calls[0].args, ['commit', '-m', 'msg']);
  assert.equal(calls[0].opts.cwd, '/x');
});
