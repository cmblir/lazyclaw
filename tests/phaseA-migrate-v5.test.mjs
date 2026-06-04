// Phase A: v4 → v5 migration baseline (spec §10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { migrateV5 } from '../scripts/migrate-v5.mjs';
import { openIndex, recall, closeIndex } from '../mas/index_db.mjs';
import { parseFrontmatter } from '../skills.mjs';

const FIXTURES = path.join(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), 'fixtures/v4-installs');

function copyFixture(name) {
  const src = path.join(FIXTURES, name);
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), `lazyclaw-mig-${name}-`));
  fs.cpSync(src, dst, { recursive: true });
  return dst;
}

test('migrate(empty): creates backup, writes default config, builds empty index', async () => {
  const dir = copyFixture('empty');
  const out = await migrateV5({ configDir: dir });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(fs.existsSync(out.backupDir), 'backup missing');
  assert.ok(fs.existsSync(path.join(dir, 'index.db')));
  closeIndex(dir);
});

test('migrate(with-sessions): rewrites config with trainer:auto and indexes existing turns', async () => {
  const dir = copyFixture('with-sessions');
  const out = await migrateV5({ configDir: dir });
  assert.equal(out.ok, true);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(cfg.trainer?.provider, 'auto', `trainer.provider = ${cfg.trainer?.provider}`);
  openIndex(dir);
  const hits = recall('daemon', { configDir: dir, scope: ['sessions'] });
  assert.ok(hits.hits.length >= 1, 'session turns not indexed');
  closeIndex(dir);
});

test('migrate(with-skills): upgrades skill frontmatter with group + trained_by (C4/C5)', async () => {
  const dir = copyFixture('with-skills');
  const out = await migrateV5({ configDir: dir });
  assert.equal(out.ok, true);
  const skillPath = path.join(dir, 'skills/dev-review.md');
  const raw = fs.readFileSync(skillPath, 'utf8');
  const { meta } = parseFrontmatter(raw);
  assert.equal(meta.group, 'dev', `group = ${meta.group}`);
  // trained_by defaults to 'legacy' for pre-v5 skills (canonical C4).
  assert.equal(meta.trained_by, 'legacy', `trained_by = ${meta.trained_by}`);
  openIndex(dir);
  const hits = recall('diff', { configDir: dir, scope: ['skills'] });
  assert.ok(hits.hits.length >= 1, 'skill not indexed after migration');
  closeIndex(dir);
});

test('migrate is idempotent: second run does not duplicate backup or skill frontmatter', async () => {
  const dir = copyFixture('with-skills');
  await migrateV5({ configDir: dir });
  const skillAfter1 = fs.readFileSync(path.join(dir, 'skills/dev-review.md'), 'utf8');
  await migrateV5({ configDir: dir });
  const skillAfter2 = fs.readFileSync(path.join(dir, 'skills/dev-review.md'), 'utf8');
  assert.equal(skillAfter1, skillAfter2, 'second migration mutated the skill');
  closeIndex(dir);
});
