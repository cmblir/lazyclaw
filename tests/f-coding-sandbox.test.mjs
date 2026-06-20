// f-coding-sandbox — a configured sandbox spec must reach python_exec/node_exec.
//
// Pre-fix: mas/tools/coding.mjs runProc always bare-spawned the interpreter and
// ignored any sandbox spec, so a --sandbox docker:... run executed arbitrary
// python/node code on the HOST. These tests pin that the spec threads down,
// EXACTLY mirroring bash.mjs (tests/f-sandbox-application.test.mjs):
//   - ctx.sandbox=<spec> → routed through spawnSandboxed (injected seam)
//   - ctx without sandbox → bare path, _spawnSandboxed NEVER invoked
//
// Tests are host-independent: routing is asserted via the injected seam, so no
// python3/node binary is required (the fake child resolves exec synthetically).

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TOOLS } from '../mas/tools/coding.mjs';

const python_exec = TOOLS.find((t) => t.name === 'python_exec');
const node_exec = TOOLS.find((t) => t.name === 'node_exec');

// Build a fake child the runProc streaming/close logic can drive to resolution.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {} };
  child.kill = () => {};
  return child;
}

test('python_exec routes through the injected sandbox spawner exactly once', async () => {
  const calls = [];
  const spec = { kind: 'local', confiner: 'none' };
  const child = fakeChild();
  const fake = (s, bin, args, opts) => {
    calls.push({ s, bin, args, opts });
    queueMicrotask(() => child.emit('close', 0));
    return child;
  };
  const r = await python_exec.exec(
    { code: 'x' },
    { cwd: '/work', python: 'python3', sandbox: spec, _spawnSandboxed: fake }
  );
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1, 'spawnSandboxed must be called exactly once');
  assert.equal(calls[0].s, spec, 'the parsed spec must be passed through by identity');
  assert.equal(calls[0].bin, 'python3', 'bin must be the python interpreter');
  assert.deepEqual(calls[0].args, ['-c', 'x'], 'args must be the python -c snippet');
  assert.equal(calls[0].opts.cwd, '/work');
  assert.equal(typeof calls[0].opts.env, 'object', 'a scrubbed env object must still be applied');
});

test('node_exec routes through the injected sandbox spawner exactly once', async () => {
  const calls = [];
  const spec = { kind: 'local', confiner: 'none' };
  const child = fakeChild();
  const fake = (s, bin, args, opts) => {
    calls.push({ s, bin, args, opts });
    queueMicrotask(() => child.emit('close', 0));
    return child;
  };
  const r = await node_exec.exec(
    { code: 'print(1)' },
    { cwd: '/work', node: '/usr/bin/node', sandbox: spec, _spawnSandboxed: fake }
  );
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1, 'spawnSandboxed must be called exactly once');
  assert.equal(calls[0].s, spec, 'the parsed spec must be passed through by identity');
  assert.equal(calls[0].bin, '/usr/bin/node', 'bin must be the node interpreter');
  assert.deepEqual(calls[0].args, ['-e', 'print(1)'], 'args must be the node -e snippet');
  assert.equal(typeof calls[0].opts.env, 'object', 'a scrubbed env object must still be applied');
});

test('python_exec with NO sandbox takes the bare path (never calls the spawner)', async () => {
  let called = false;
  const fake = () => { called = true; return fakeChild(); };
  // No sandbox in ctx → must take the bare spawn branch. Use a code snippet
  // that the real interpreter can run; what matters is the seam is untouched.
  await python_exec.exec({ code: 'pass' }, { _spawnSandboxed: fake });
  assert.equal(called, false, 'absent sandbox must NOT route through spawnSandboxed');
});

test('node_exec with NO sandbox takes the bare path (never calls the spawner)', async () => {
  let called = false;
  const fake = () => { called = true; return fakeChild(); };
  await node_exec.exec({ code: '0' }, { _spawnSandboxed: fake });
  assert.equal(called, false, 'absent sandbox must NOT route through spawnSandboxed');
});
