import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { defaultSandboxSpec } from '../sandbox/index.mjs';

test('default-on: empty cfg yields a local filesystem-confinement spec (confiner auto, net allowed)', () => {
  const spec = defaultSandboxSpec({}, { cwd: '/work/proj' });
  assert.equal(spec.kind, 'local');
  assert.equal(spec.confiner, 'auto');
  assert.deepEqual(spec.readWrite, ['/work/proj']);
  assert.equal(spec.allowNet, true);
  // secret dirs are blocked from reads
  assert.ok(spec.denyRead.includes(path.join(os.homedir(), '.ssh')));
  assert.ok(spec.denyRead.includes(path.join(os.homedir(), '.aws')));
});

test('default-on: the lazyclaw configDir (holds auth/tokens) is added to denyRead', () => {
  const spec = defaultSandboxSpec({}, { cwd: '/w', configDir: '/home/u/.lazyclaw' });
  assert.ok(spec.denyRead.includes('/home/u/.lazyclaw'));
});

test('opt-out: cfg.sandbox.confine === false disables confinement (null spec)', () => {
  assert.equal(defaultSandboxSpec({ sandbox: { confine: false } }, { cwd: '/w' }), null);
});

test('opt-out: cfg.sandbox.default "off" or "none" disables confinement', () => {
  assert.equal(defaultSandboxSpec({ sandbox: { default: 'off' } }, { cwd: '/w' }), null);
  assert.equal(defaultSandboxSpec({ sandbox: { default: 'none' } }, { cwd: '/w' }), null);
});

test('allowNet:false in cfg flows into the spec (deny network)', () => {
  const spec = defaultSandboxSpec({ sandbox: { allowNet: false } }, { cwd: '/w' });
  assert.equal(spec.allowNet, false);
});

test('explicit confiner in cfg overrides auto', () => {
  const spec = defaultSandboxSpec({ sandbox: { local: { confiner: 'bubblewrap' } } }, { cwd: '/w' });
  assert.equal(spec.confiner, 'bubblewrap');
});

test('configured docker default backend is honoured as a docker spec', () => {
  const spec = defaultSandboxSpec({ sandbox: { default: 'docker', docker: { image: 'node:20' } } }, { cwd: '/w' });
  assert.equal(spec.kind, 'docker');
  assert.equal(spec.image, 'node:20');
});

test('no cwd falls back to process.cwd()', () => {
  const spec = defaultSandboxSpec({}, {});
  assert.deepEqual(spec.readWrite, [process.cwd()]);
});
