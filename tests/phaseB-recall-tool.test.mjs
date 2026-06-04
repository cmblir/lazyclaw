// Phase B: recall tool — FTS5 cross-scope query (spec §4.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as recallTool from '../mas/tools/recall.mjs';
import { openIndex, indexSkill, indexSessionTurn, closeIndex } from '../mas/index_db.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-recall-'));
}

test('recall tool: rejects empty query', async () => {
  const out = await recallTool.exec({ query: '' }, { configDir: tmpDir() });
  assert.equal(out.ok, false);
  assert.match(out.error, /query/i);
});

test('recall tool: returns hits across requested scopes', async () => {
  const dir = tmpDir();
  openIndex(dir);
  indexSkill({ skill_name: 'fix-flake', trained_by: 'claude-cli', group_name: 'dev', content: 'how to fix flaky tests in playwright' }, dir);
  indexSessionTurn({ session_id: 's1', turn_idx: 0, role: 'user', ts: 1, content: 'why is my playwright test flaky' }, dir);
  const out = await recallTool.exec({ query: 'flaky playwright', scope: ['sessions', 'skills'], k: 5 }, { configDir: dir });
  assert.equal(out.ok, true);
  assert.ok(out.hits.length > 0, `expected hits, got ${out.hits.length}`);
  const scopes = new Set(out.hits.map((h) => h.scope));
  assert.ok(scopes.has('skills') || scopes.has('sessions'));
  closeIndex(dir);
});

test('recall tool: caps k at 50', async () => {
  const dir = tmpDir();
  openIndex(dir);
  for (let i = 0; i < 100; i++) {
    indexSkill({ skill_name: `s${i}`, trained_by: 'claude-cli', group_name: 'dev', content: 'token ' + i }, dir);
  }
  const out = await recallTool.exec({ query: 'token', scope: ['skills'], k: 999 }, { configDir: dir });
  assert.equal(out.ok, true);
  assert.ok(out.hits.length <= 50, `expected <=50, got ${out.hits.length}`);
  closeIndex(dir);
});

test('tool_runner: recall is registered and discoverable', async () => {
  const runner = await import('../mas/tool_runner.mjs');
  const schemas = runner.listToolSchemas();
  const names = schemas.map((s) => s.name);
  assert.ok(names.includes('recall'), `expected recall in [${names.join(', ')}]`);
});
