import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DockerSandbox, parseSandboxSpec, buildDockerArgs,
} from '../sandbox/docker.mjs';
import { SANDBOX_KINDS, SandboxError } from '../sandbox/base.mjs';

test('parseSandboxSpec returns null for off/none/-', () => {
  for (const v of ['off', 'none', '-', '']) {
    assert.equal(parseSandboxSpec(v), null);
  }
});

test('parseSandboxSpec("docker:node:20") yields canonical spec', () => {
  const s = parseSandboxSpec('docker:node:20', {});
  assert.equal(s.kind, 'docker');
  assert.equal(s.image, 'node:20');
  assert.equal(s.network, 'none');
  assert.deepEqual(s.mounts, []);
});

test('buildDockerArgs preserves v4 argv layout', () => {
  const spec = parseSandboxSpec('docker:node:20', {
    'sandbox-mount': '/h/.claude:/root/.claude:ro',
    'sandbox-env': 'OPENAI_API_KEY',
    'sandbox-network': 'bridge',
  });
  const argv = buildDockerArgs(spec, ['claude', '-p', 'hi'], { cwd: '/work' });
  assert.deepEqual(argv, [
    'run', '--rm', '-i',
    '--network', 'bridge',
    '-v', '/work:/work',
    '-w', '/work',
    '-v', '/h/.claude:/root/.claude:ro',
    '-e', 'OPENAI_API_KEY',
    'node:20', 'claude', '-p', 'hi',
  ]);
});

test('DockerSandbox is registered under kind="docker"', () => {
  assert.ok(SANDBOX_KINDS.includes('docker'));
  const sb = new DockerSandbox(parseSandboxSpec('docker:alpine:3.20'));
  assert.equal(sb.spec.kind, 'docker');
  assert.match(sb.describe(), /docker.*alpine:3\.20/);
});

test('bad spec throws SandboxError with stable code', () => {
  assert.throws(() => parseSandboxSpec('podman:fedora'), (e) =>
    e instanceof SandboxError && e.code === 'SANDBOX_UNSUPPORTED');
  assert.throws(() => parseSandboxSpec('garbage'), (e) =>
    e instanceof SandboxError && e.code === 'SANDBOX_BAD_SPEC');
});
