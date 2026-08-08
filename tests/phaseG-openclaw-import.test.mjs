// Phase G — openclaw import smoke (spec §10).
// Ported to node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.join(process.cwd(), 'cli.mjs');

test('openclaw import smoke', () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-oc-'));
  const oc = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-fake-'));

  fs.writeFileSync(path.join(oc, 'SOUL.md'), 'OPENCLAW SOUL');
  fs.writeFileSync(path.join(oc, 'USER.md'), 'oc user facts');
  fs.writeFileSync(path.join(oc, 'MEMORY.md'), 'oc core');
  fs.mkdirSync(path.join(oc, 'skills'), { recursive: true });
  fs.writeFileSync(
    path.join(oc, 'skills', 'ops-deploy.md'),
    '---\nname: ops-deploy\ndescription: deploy\n---\nbody'
  );
  fs.writeFileSync(path.join(oc, 'allowlist.json'), '{"bash":["ls","pwd"]}');
  fs.writeFileSync(path.join(oc, 'messaging.json'), '{"slack":{"botToken":"xoxb-oc"}}');

  const r = spawnSync(
    process.execPath, [CLI, 'openclaw', 'import', '--from', oc],
    { env: { ...process.env, POMPOS_CONFIG_DIR: cfgDir, POMPOS_NO_INK: '1' }, encoding: 'utf8' }
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);

  assert.ok(fs.readFileSync(path.join(cfgDir, 'SOUL.md'), 'utf8').includes('OPENCLAW SOUL'));
  assert.ok(fs.readFileSync(path.join(cfgDir, 'memory', 'USER.md'), 'utf8').includes('oc user facts'));
  assert.ok(fs.readFileSync(path.join(cfgDir, 'memory', 'core.md'), 'utf8').includes('oc core'));
  const sk = fs.readFileSync(path.join(cfgDir, 'skills', 'ops-deploy.md'), 'utf8');
  assert.match(sk, /trained_by:\s*openclaw-import/);

  const cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8'));
  assert.ok(cfg.allowlist?.bash?.includes('ls'));
  assert.equal(cfg.channels?.slack?.botToken, 'xoxb-oc');
});
