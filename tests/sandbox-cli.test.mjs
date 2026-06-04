import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../cli.mjs', import.meta.url).pathname;

function run(argv, env = {}) {
  const r = spawnSync('node', [CLI, ...argv], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('lazyclaw sandbox list prints the 6-enum', () => {
  const r = run(['sandbox', 'list']);
  assert.equal(r.code, 0, r.stderr);
  for (const k of ['local', 'docker', 'ssh', 'singularity', 'modal', 'daytona']) {
    assert.match(r.stdout, new RegExp(`\\b${k}\\b`));
  }
});

test('lazyclaw sandbox test local succeeds (echo through LocalSandbox)', () => {
  const r = run(['sandbox', 'test', 'local']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ok\s+local/i);
});

test('lazyclaw sandbox add writes to a temp config dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lazyclaw-sb-'));
  const cfg = join(dir, 'config.json');
  writeFileSync(cfg, '{}');
  const r = run(
    ['sandbox', 'add', 'staging', '--kind', 'docker', '--image', 'alpine:3.20'],
    { LAZYCLAW_CONFIG: cfg },
  );
  assert.equal(r.code, 0, r.stderr);
  const written = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.equal(written.sandbox.profiles.staging.kind, 'docker');
  assert.equal(written.sandbox.profiles.staging.image, 'alpine:3.20');
});

test('lazyclaw sandbox use selects a profile as default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lazyclaw-sb-'));
  const cfg = join(dir, 'config.json');
  writeFileSync(cfg, JSON.stringify({
    sandbox: { profiles: { staging: { kind: 'docker', image: 'x' } } },
  }));
  const r = run(['sandbox', 'use', 'staging'], { LAZYCLAW_CONFIG: cfg });
  assert.equal(r.code, 0, r.stderr);
  const written = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.equal(written.sandbox.default, 'docker');
  assert.equal(written.sandbox.docker.image, 'x');
});

test('lazyclaw sandbox test unknown-backend reports error and exits non-zero', () => {
  const r = run(['sandbox', 'test', 'no-such-kind']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /SANDBOX_BAD_KIND|unknown/i);
});
