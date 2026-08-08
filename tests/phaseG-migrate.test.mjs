// Phase G — full v4 → v5 migration (spec §1.7, §10; decisions C4, C5, C7, C8, C9).
// Ported to node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.join(process.cwd(), 'cli.mjs');
const FIX = path.join(process.cwd(), 'tests', 'fixtures');

function setup(fixtureName) {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), `lc-mig-${fixtureName}-`));
  const cfgSrc = path.join(FIX, fixtureName, 'config.json');
  fs.writeFileSync(path.join(dst, 'config.json'), fs.readFileSync(cfgSrc, 'utf8'));
  return dst;
}

function run(args, cfgDir) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, POMPOS_CONFIG_DIR: cfgDir, POMPOS_NO_INK: '1' },
    encoding: 'utf8',
  });
}

test('migrate v4-minimal: writes backup + injects trainer default', () => {
  const cfgDir = setup('v4-minimal');
  const r = run(['migrate'], cfgDir);
  assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  const cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8'));
  assert.ok(cfg.trainer, `trainer absent: ${JSON.stringify(cfg)}`);
  // Backup directory lives at <cfgDir>.v4.backup
  assert.equal(fs.existsSync(`${cfgDir}.v4.backup`), true);
});

test('migrate v4-slack-heavy: sandbox string → object', () => {
  const cfgDir = setup('v4-slack-heavy');
  const r = run(['migrate'], cfgDir);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8'));
  assert.equal(typeof cfg.sandbox, 'object');
  assert.equal(cfg.sandbox.backend, 'docker');
  assert.equal(cfg.channels.slack.botToken, 'xoxb-xxx'); // preserved
});

test('migrate v4-skill-heavy: orchestrator → orchestra + skill frontmatter upgrade', () => {
  const cfgDir = setup('v4-skill-heavy');
  // Seed a v4 skill with no group/confidence/trained_by
  fs.mkdirSync(path.join(cfgDir, 'skills'), { recursive: true });
  fs.writeFileSync(
    path.join(cfgDir, 'skills', 'dev-review.md'),
    '---\nname: dev-review\ndescription: review code\nversion: 2\n---\n# body'
  );
  fs.writeFileSync(
    path.join(cfgDir, 'skills', 'standalone.md'),
    '---\nname: standalone\ndescription: noop\n---\n# body'
  );
  const r = run(['migrate'], cfgDir);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);

  const cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8'));
  assert.ok(cfg.orchestra);
  assert.equal(cfg.orchestrator, undefined);

  const sk1 = fs.readFileSync(path.join(cfgDir, 'skills', 'dev-review.md'), 'utf8');
  assert.match(sk1, /group:\s*dev/);              // C5 hyphen prefix
  assert.match(sk1, /confidence:\s*0\.5/);
  assert.match(sk1, /trained_by:\s*legacy/);

  const sk2 = fs.readFileSync(path.join(cfgDir, 'skills', 'standalone.md'), 'utf8');
  assert.match(sk2, /group:\s*legacy/);            // no hyphen → legacy (C5)
});

test('migrate rollback restores the snapshot', () => {
  const cfgDir = setup('v4-minimal');
  const before = fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8');
  assert.equal(run(['migrate'], cfgDir).status, 0);
  assert.equal(run(['migrate', 'rollback'], cfgDir).status, 0);
  const after = fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8');
  assert.equal(after.trim(), before.trim());
});
