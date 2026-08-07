// tests/f-phase0-recall-confidence.test.mjs
//
// Phase 0 (recall-confidence): the confidence subsystem must stop being
// write-only. Skills carry a frontmatter `confidence` stamped by
// mas/confidence.mjs, but recall used to rank purely by bm25 — so a
// low-confidence skill and a proven one with the same lexical match ranked
// identically. This fixes ranking to weight skills-scope hits by their
// frontmatter confidence (default 0.5, floored) AND to dampen a skill whose
// trainer provider family differs from the worker provider family
// (confidence.crossCliDampen). Non-skills scopes are unaffected.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIndex, closeIndex, indexSkill, indexSessionTurn, recall } from '../mas/index_db.mjs';
import { DEFAULT_CROSS_CLI_DAMPEN } from '../mas/confidence.mjs';
import * as recallTool from '../mas/tools/recall.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-p0conf-'));

// Write a skill .md with the given frontmatter fields, then index its body so
// it is recallable. Keeps the on-disk frontmatter (confidence/trained_by) as
// the single source of truth the ranker must read.
function writeSkill(dir, { name, confidence, trainedBy, body }) {
  const skillsDir = path.join(dir, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  const fm = ['---', `name: ${name}`, `version: 1`, `group: t`, `created_by: test`];
  if (trainedBy) fm.push(`trained_by: ${trainedBy}`);
  if (confidence !== undefined) fm.push(`confidence: ${confidence}`);
  fm.push('---', '');
  fs.writeFileSync(path.join(skillsDir, `${name}.md`), `${fm.join('\n')}\n${body}\n`);
  indexSkill({ skill_name: name, trained_by: trainedBy || '', group_name: 't', content: body }, dir);
}

test('between two equal-bm25 skills, the higher-confidence one ranks first', () => {
  const dir = tmp();
  openIndex(dir);
  // Identical bodies → identical bm25 for the same MATCH. Only confidence differs.
  const body = 'deploy the release pipeline safely with a rollback plan';
  writeSkill(dir, { name: 'low-conf', confidence: 0.33, trainedBy: 'claude-cli', body });
  writeSkill(dir, { name: 'high-conf', confidence: 0.9, trainedBy: 'claude-cli', body });

  const out = recall('deploy release pipeline rollback', { configDir: dir, scope: ['skills'], workerProvider: 'anthropic' });
  assert.equal(out.hits.length, 2, `both skills should match; got ${out.hits.length}`);
  assert.equal(out.hits[0].metadata.skill_name, 'high-conf',
    `higher-confidence skill must rank first; got ${out.hits.map((h) => h.metadata.skill_name).join(',')}`);
  closeIndex(dir);
});

test('a cross-family skill is dampened below a same-family skill of equal bm25 and confidence', () => {
  const dir = tmp();
  openIndex(dir);
  const body = 'configure the load balancer and health checks for the service';
  // Same confidence — only the trainer/worker family relationship differs.
  writeSkill(dir, { name: 'same-fam', confidence: 0.7, trainedBy: 'claude-cli', body });
  writeSkill(dir, { name: 'cross-fam', confidence: 0.7, trainedBy: 'codex-cli', body });

  // Worker is anthropic: same-fam (claude-cli) is undampened; cross-fam
  // (codex-cli) is multiplied by the cross-CLI dampen factor → demoted.
  const out = recall('configure load balancer health checks', { configDir: dir, scope: ['skills'], workerProvider: 'anthropic' });
  assert.equal(out.hits.length, 2);
  assert.equal(out.hits[0].metadata.skill_name, 'same-fam',
    `cross-family skill must be dampened below the same-family one; got ${out.hits.map((h) => h.metadata.skill_name).join(',')}`);
  assert.ok(DEFAULT_CROSS_CLI_DAMPEN < 1, 'sanity: dampen factor is a demotion');
  closeIndex(dir);
});

test('a low-confidence skill is demoted below a proven one but NOT erased from the results', () => {
  const dir = tmp();
  openIndex(dir);
  const body = 'write a migration script that backfill the new column';
  writeSkill(dir, { name: 'proven', confidence: 0.9, trainedBy: 'claude-cli', body });
  writeSkill(dir, { name: 'shaky', confidence: 0.05, trainedBy: 'claude-cli', body });

  const out = recall('migration script backfill column', { configDir: dir, scope: ['skills'], workerProvider: 'anthropic' });
  assert.equal(out.hits.length, 2, 'the low-confidence skill must still be recallable, only demoted');
  assert.equal(out.hits[0].metadata.skill_name, 'proven');
  assert.equal(out.hits[1].metadata.skill_name, 'shaky');
  closeIndex(dir);
});

test('a skill with no confidence frontmatter defaults to 0.5 (ranks below a 0.9 skill)', () => {
  const dir = tmp();
  openIndex(dir);
  const body = 'set up structured logging with request ids across the stack';
  writeSkill(dir, { name: 'stamped', confidence: 0.9, trainedBy: 'claude-cli', body });
  writeSkill(dir, { name: 'unstamped', trainedBy: 'claude-cli', body }); // no confidence key

  const out = recall('structured logging request ids', { configDir: dir, scope: ['skills'], workerProvider: 'anthropic' });
  assert.equal(out.hits.length, 2);
  assert.equal(out.hits[0].metadata.skill_name, 'stamped');
  closeIndex(dir);
});

test('recall TOOL forwards workerProvider so confidence ranking applies end-to-end', async () => {
  const dir = tmp();
  openIndex(dir);
  const body = 'roll out the feature flag gradually and monitor error rates';
  writeSkill(dir, { name: 'weak', confidence: 0.2, trainedBy: 'claude-cli', body });
  writeSkill(dir, { name: 'strong', confidence: 0.95, trainedBy: 'claude-cli', body });

  const res = await recallTool.exec(
    { query: 'roll out feature flag monitor error rates', scope: ['skills'], workerProvider: 'anthropic', k: 5 },
    { configDir: dir });
  assert.equal(res.ok, true, `recall tool should succeed; err=${res.error}`);
  assert.equal(res.hits[0].metadata.skill_name, 'strong',
    `tool must rank the high-confidence skill first; got ${res.hits.map((h) => h.metadata.skill_name).join(',')}`);
  closeIndex(dir);
});

test('non-skills scopes are unaffected: sessions keep pure bm25 order and byte-stable hit shape', () => {
  const dir = tmp();
  openIndex(dir);
  indexSessionTurn({ session_id: 's1', turn_idx: 0, role: 'user', ts: 1, content: 'shared topic about alpha' }, dir);
  indexSessionTurn({ session_id: 's2', turn_idx: 0, role: 'user', ts: 2, content: 'shared topic about beta' }, dir);

  const withProvider = recall('shared topic', { configDir: dir, scope: ['sessions'], workerProvider: 'anthropic' });
  const without = recall('shared topic', { configDir: dir, scope: ['sessions'] });
  assert.deepEqual(
    withProvider.hits.map((h) => h.metadata.session_id),
    without.hits.map((h) => h.metadata.session_id),
    'workerProvider must not reorder non-skills hits');
  for (const h of withProvider.hits) {
    assert.deepEqual(Object.keys(h).sort(), ['bm25', 'metadata', 'rank', 'scope', 'snippet'].sort(),
      'session hit shape must stay byte-stable');
  }
  closeIndex(dir);
});
