import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSandbox } from '../sandbox/index.mjs';

const CFG = {
  sandbox: {
    default: 'local',
    local:  { confiner: 'none' },
    docker: { image: 'node:20' },
    ssh:    { host: 'box.local', user: 'me' },
    bindings: {
      'planner':  'local',
      'worker-1': 'docker',
      'worker-2': { kind: 'ssh', host: 'gpu.example', user: 'agent' },
      'worker-3': 'singularity',
    },
    singularity: { image: '/scratch/agent.sif' },
  },
};

test('planner binding stays local', () => {
  const sb = resolveSandbox(CFG, 'planner');
  assert.equal(sb.spec.kind, 'local');
});

test('worker-1 binding switches to docker', () => {
  const sb = resolveSandbox(CFG, 'worker-1');
  assert.equal(sb.spec.kind, 'docker');
  assert.equal(sb.spec.image, 'node:20');
});

test('worker-2 object-binding overrides ssh host', () => {
  const sb = resolveSandbox(CFG, 'worker-2');
  assert.equal(sb.spec.kind, 'ssh');
  assert.equal(sb.spec.host, 'gpu.example');
  assert.equal(sb.spec.user, 'agent');
});

test('worker-3 binding uses singularity section defaults', () => {
  const sb = resolveSandbox(CFG, 'worker-3');
  assert.equal(sb.spec.kind, 'singularity');
  assert.equal(sb.spec.image, '/scratch/agent.sif');
});

test('unknown worker falls back to sandbox.default', () => {
  const sb = resolveSandbox(CFG, 'unknown-worker');
  assert.equal(sb.spec.kind, 'local');
});
