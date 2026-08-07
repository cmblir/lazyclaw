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

test('pompos sandbox list prints the 6-enum', () => {
  const r = run(['sandbox', 'list']);
  assert.equal(r.code, 0, r.stderr);
  for (const k of ['local', 'docker', 'ssh', 'singularity', 'modal', 'daytona']) {
    assert.match(r.stdout, new RegExp(`\\b${k}\\b`));
  }
});

test('pompos sandbox status reports the default-on confinement posture', () => {
  const r = run(['sandbox', 'status']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /confinement:\s*on/i, 'default-on confinement must be reported');
  assert.match(r.stdout, /\b(seatbelt|bubblewrap|firejail|none)\b/, 'host confiner must be shown');
  assert.match(r.stdout, /network/i);
});

test('pompos sandbox status shows OFF when confine is disabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-sbstatus-'));
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({ sandbox: { confine: false } }));
  const r = run(['sandbox', 'status'], { LAZYCLAW_CONFIG: cfgPath });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /confinement:\s*off/i);
});

test('pompos sandbox test local succeeds (echo through LocalSandbox)', () => {
  const r = run(['sandbox', 'test', 'local']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ok\s+local/i);
});

test('pompos sandbox add writes to a temp config dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pompos-sb-'));
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

test('pompos sandbox use selects a profile as default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pompos-sb-'));
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

test('pompos sandbox test unknown-backend reports error and exits non-zero', () => {
  const r = run(['sandbox', 'test', 'no-such-kind']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /SANDBOX_BAD_KIND|unknown/i);
});
