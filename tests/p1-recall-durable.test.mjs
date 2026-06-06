// P1 — recall is durable (rebuild repopulates) and dedup'd (no duplicate rows).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reindexAll, recall, openIndex, indexSkill, closeIndex } from '../mas/index_db.mjs';

function tmpCfg() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-recall-')); }

test('reindexAll repopulates recall from on-disk sessions + skills', () => {
  const cfg = tmpCfg();
  fs.mkdirSync(path.join(cfg, 'sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'sessions', 's1.jsonl'),
    JSON.stringify({ role: 'user', content: 'deploy the canarybuild tonight', ts: 1 }) + '\n',
  );
  fs.mkdirSync(path.join(cfg, 'skills'), { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'skills', 'deploy-flow.md'),
    '---\nname: deploy-flow\ntrained_by: user\ngroup: deploy\n---\n\ncanarybuild rollout steps',
  );
  reindexAll(cfg);
  const r = recall('canarybuild', { configDir: cfg });
  closeIndex(cfg);
  // A bare rebuild() (the old behavior) would return zero hits here.
  assert.ok(r.hits.length >= 1, `reindexAll should make content recallable, got ${r.hits.length}`);
});

test('indexSkill upserts by name — re-indexing the same skill does not duplicate', () => {
  const cfg = tmpCfg();
  openIndex(cfg, { runIntegrityCheck: false });
  indexSkill({ skill_name: 'deploy', trained_by: 'user', group_name: 'deploy', content: 'uniquetoken rollout' }, cfg);
  indexSkill({ skill_name: 'deploy', trained_by: 'user', group_name: 'deploy', content: 'uniquetoken rollout v2' }, cfg);
  const r = recall('uniquetoken', { configDir: cfg, scope: ['skills'] });
  closeIndex(cfg);
  assert.equal(r.hits.length, 1, 'upsert must keep exactly one row for the skill');
});
