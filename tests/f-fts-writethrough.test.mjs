// f-fts-writethrough — FTS5 recall write-through gaps (task g2).
//
// Pins four pre-fix gaps:
//   (a) skill_create bypasses FTS — a new skill is not recallable until
//       reindexAll runs.
//   (b) index_db has no exported deleteSkill operation, so a removed
//       skill's FTS row keeps surfacing.
//   (c) recall filter "since" drops every hit that simply lacks a ts
//       (skills/memories/trajectories have no ts column).
//   (d) recall snippets carry <mark>..</mark> markup injected into agent
//       prompts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as learning from '../mas/tools/learning.mjs';
import * as recallTool from '../mas/tools/recall.mjs';
import { openIndex, indexSkill, deleteSkill, recall, closeIndex } from '../mas/index_db.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-fts-wt-'));
}

function tool(name) {
  return learning.TOOLS.find((t) => t.name === name);
}

// (a) skill_create write-through: a freshly created skill is findable via
// recall without a reindexAll.
test('skill_create indexes the new skill into FTS (recallable immediately)', async () => {
  const dir = tmpDir();
  const res = await tool('skill_create').exec(
    { name: 'parse-csv-fast', body: 'how to parse csv quickly with streaming', group: 'dev' },
    { configDir: dir },
  );
  assert.equal(res.ok, true);

  const out = await recallTool.exec({ query: 'streaming csv', scope: ['skills'], k: 5 }, { configDir: dir });
  assert.equal(out.ok, true);
  const names = out.hits.map((h) => h.metadata?.skill_name);
  assert.ok(names.includes('parse-csv-fast'), `expected parse-csv-fast in [${names.join(', ')}]`);
  closeIndex(dir);
});

// (a') skill_edit write-through: edited body is re-indexed.
test('skill_edit re-indexes the updated body into FTS', async () => {
  const dir = tmpDir();
  await tool('skill_create').exec({ name: 'deploy-flow', body: 'old deployment notes', group: 'dev' }, { configDir: dir });
  const res = await tool('skill_edit').exec(
    { name: 'deploy-flow', body: 'kubernetes rollout canary procedure' },
    { configDir: dir },
  );
  assert.equal(res.ok, true);

  const out = await recallTool.exec({ query: 'kubernetes canary', scope: ['skills'], k: 5 }, { configDir: dir });
  assert.equal(out.ok, true);
  const names = out.hits.map((h) => h.metadata?.skill_name);
  assert.ok(names.includes('deploy-flow'), `expected deploy-flow in [${names.join(', ')}]`);
  closeIndex(dir);
});

// (a'') memory_write write-through: core + episodic memories are findable.
test('memory_write (core/episodic) indexes into FTS', async () => {
  const dir = tmpDir();
  await tool('memory_write').exec({ kind: 'core', content: 'user prefers vitest over jest' }, { configDir: dir });
  await tool('memory_write').exec({ kind: 'episodic', topic: 'onboarding', content: 'onboarding ran in october' }, { configDir: dir });

  const core = await recallTool.exec({ query: 'vitest jest', scope: ['memories'], k: 5 }, { configDir: dir });
  assert.equal(core.ok, true);
  assert.ok(core.hits.length > 0, 'expected core memory hit');

  const epi = await recallTool.exec({ query: 'onboarding october', scope: ['memories'], k: 5 }, { configDir: dir });
  assert.equal(epi.ok, true);
  assert.ok(epi.hits.length > 0, 'expected episodic memory hit');
  closeIndex(dir);
});

// (b) index_db.deleteSkill removes the FTS row so a removed skill stops
// surfacing.
test('index_db.deleteSkill removes the FTS row', async () => {
  const dir = tmpDir();
  openIndex(dir);
  indexSkill({ skill_name: 'gone-skill', trained_by: 'user', group_name: 'dev', content: 'soon to be archived unique-token-zzz' }, dir);

  let out = recall('unique-token-zzz', { configDir: dir, scope: ['skills'], k: 5 });
  assert.ok(out.hits.some((h) => h.metadata?.skill_name === 'gone-skill'), 'expected hit before delete');

  deleteSkill('gone-skill', dir);

  out = recall('unique-token-zzz', { configDir: dir, scope: ['skills'], k: 5 });
  assert.ok(!out.hits.some((h) => h.metadata?.skill_name === 'gone-skill'), 'expected no hit after deleteSkill');
  closeIndex(dir);
});

// (c) recall with since=<recent> must not drop a skill hit that lacks a ts.
test('recall since filter keeps hits that have no ts', async () => {
  const dir = tmpDir();
  openIndex(dir);
  indexSkill({ skill_name: 'no-ts-skill', trained_by: 'user', group_name: 'dev', content: 'recall-since-token-abc' }, dir);

  const recent = Date.now() - 1000;
  const out = await recallTool.exec(
    { query: 'recall-since-token-abc', scope: ['skills'], k: 5, filter: { since: recent } },
    { configDir: dir },
  );
  assert.equal(out.ok, true);
  const names = out.hits.map((h) => h.metadata?.skill_name);
  assert.ok(names.includes('no-ts-skill'), `since filter dropped a ts-less hit; got [${names.join(', ')}]`);
  closeIndex(dir);
});

// (d) recall snippets must not contain <mark>..</mark> markup.
test('recall snippets contain no <mark> markup', async () => {
  const dir = tmpDir();
  openIndex(dir);
  // Long content so FTS5 snippet() emits a windowed snippet around the match.
  const filler = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  indexSkill({ skill_name: 'mark-skill', trained_by: 'user', group_name: 'dev', content: `${filler} markhighlight ${filler}` }, dir);

  const out = await recallTool.exec({ query: 'markhighlight', scope: ['skills'], k: 5 }, { configDir: dir });
  assert.equal(out.ok, true);
  assert.ok(out.hits.length > 0, 'expected a hit to inspect its snippet');
  for (const h of out.hits) {
    assert.ok(!/<\/?mark>/.test(String(h.snippet ?? '')), `snippet still has <mark> markup: ${h.snippet}`);
  }
  closeIndex(dir);
});
