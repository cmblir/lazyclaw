// Phase G — hermes import smoke (spec §10, §1.6).
// Ported to node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.join(process.cwd(), 'cli.mjs');

test('hermes import smoke: skills + USER + skin → personality', () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hi-'));
  const hermes = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-fake-'));

  fs.mkdirSync(path.join(hermes, 'skills'), { recursive: true });
  fs.writeFileSync(
    path.join(hermes, 'skills', 'dev-review.md'),
    '---\nname: dev-review\ndescription: review code\n---\nbody'
  );
  fs.writeFileSync(path.join(hermes, 'USER.md'), 'user knows ts');
  fs.writeFileSync(path.join(hermes, 'MEMORY.md'), 'core knowledge');
  fs.mkdirSync(path.join(hermes, 'skins'), { recursive: true });
  fs.writeFileSync(
    path.join(hermes, 'skins', 'pirate.yaml'),
    'name: pirate\nprompt: "arr matey"\n'
  );

  const r = spawnSync(
    process.execPath, [CLI, 'hermes', 'import', '--from', hermes],
    { env: { ...process.env, POMPOS_CONFIG_DIR: cfgDir, POMPOS_NO_INK: '1' }, encoding: 'utf8' }
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);

  const sk = fs.readFileSync(path.join(cfgDir, 'skills', 'dev-review.md'), 'utf8');
  assert.match(sk, /trained_by:\s*hermes-import/);

  const userMd = fs.readFileSync(path.join(cfgDir, 'memory', 'USER.md'), 'utf8');
  assert.ok(userMd.includes('user knows ts'));

  const core = fs.readFileSync(path.join(cfgDir, 'memory', 'core.md'), 'utf8');
  assert.ok(core.includes('core knowledge'));

  assert.equal(fs.existsSync(path.join(cfgDir, 'personalities', 'hermes-pirate.md')), true);
});
