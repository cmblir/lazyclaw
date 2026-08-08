// Phase G — `pompos personality` CLI list/show/install/remove/use (spec §9, decision C7).
// Ported to node:test (playwright not installed in this worktree).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.join(process.cwd(), 'cli.mjs');

function tmpCfg() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-pers-')); }

function run(args, cfgDir) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, POMPOS_CONFIG_DIR: cfgDir, POMPOS_NO_INK: '1' },
    encoding: 'utf8',
  });
}

test('personality list empty', () => {
  const cfgDir = tmpCfg();
  const r = run(['personality', 'list'], cfgDir);
  assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  assert.ok(r.stdout.includes('No personalities installed'), `stdout: ${r.stdout}`);
});

test('personality install + list + show + remove', () => {
  const cfgDir = tmpCfg();
  const src = path.join(cfgDir, 'pirate.md');
  fs.writeFileSync(src, '# Pirate\nArrr.');

  let r = run(['personality', 'install', 'pirate', src], cfgDir);
  assert.equal(r.status, 0, `install failed: ${r.stderr}`);
  assert.ok(fs.existsSync(path.join(cfgDir, 'personalities', 'pirate.md')));

  r = run(['personality', 'list'], cfgDir);
  assert.ok(r.stdout.includes('pirate'), `list stdout: ${r.stdout}`);

  r = run(['personality', 'show', 'pirate'], cfgDir);
  assert.ok(r.stdout.includes('Arrr.'), `show stdout: ${r.stdout}`);

  r = run(['personality', 'remove', 'pirate'], cfgDir);
  assert.equal(r.status, 0, `remove failed: ${r.stderr}`);
  assert.equal(fs.existsSync(path.join(cfgDir, 'personalities', 'pirate.md')), false);
});

test('personality use writes cfg.persona.personality', () => {
  const cfgDir = tmpCfg();
  fs.mkdirSync(path.join(cfgDir, 'personalities'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'personalities', 'pirate.md'), '# Pirate');

  const r = run(['personality', 'use', 'pirate'], cfgDir);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8'));
  assert.equal(cfg.persona?.personality, 'pirate');
});

test('personality use rejects unknown name', () => {
  const cfgDir = tmpCfg();
  const r = run(['personality', 'use', 'ghost'], cfgDir);
  assert.notEqual(r.status, 0);
  assert.ok(/not installed|not found/i.test(r.stderr + r.stdout), `combined: ${r.stderr}${r.stdout}`);
});
