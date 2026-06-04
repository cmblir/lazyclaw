import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSandbox, listBackends } from '../sandbox/index.mjs';

test('listBackends returns the 6-enum in stable order', () => {
  assert.deepEqual(listBackends(),
    ['local', 'docker', 'ssh', 'singularity', 'modal', 'daytona']);
});

test('resolveSandbox(empty cfg) falls back to LocalSandbox/none', () => {
  const sb = resolveSandbox({});
  assert.equal(sb.spec.kind, 'local');
  assert.equal(sb.spec.confiner, 'none');
});

test('cfg.sandbox.default selects the named backend', () => {
  const sb = resolveSandbox({
    sandbox: { default: 'docker', docker: { image: 'node:20' } },
  });
  assert.equal(sb.spec.kind, 'docker');
  assert.equal(sb.spec.image, 'node:20');
});

test('cfg.sandbox.bindings[workerName] overrides default', () => {
  const sb = resolveSandbox({
    sandbox: {
      default: 'local',
      docker: { image: 'alpine:3.20' },
      bindings: { 'worker-2': 'docker' },
    },
  }, 'worker-2');
  assert.equal(sb.spec.kind, 'docker');
  assert.equal(sb.spec.image, 'alpine:3.20');
});

test('unknown backend in cfg throws SandboxError', () => {
  assert.throws(() => resolveSandbox({ sandbox: { default: 'podman' } }),
    /SANDBOX_BAD_KIND/);
});
