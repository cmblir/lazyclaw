// Phase A: write-through hooks (spec §4.4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendTurn } from '../sessions.mjs';
import { installSynthesized } from '../mas/skill_synth.mjs';
import { put as trajPut } from '../mas/trajectory_store.mjs';
import { openIndex, recall, closeIndex } from '../mas/index_db.mjs';

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-hooks-'));
  process.env.POMPOS_CONFIG_DIR = d;
  return d;
}

test('appendTurn writes through to fts_sessions', async () => {
  const dir = tmp();
  openIndex(dir);
  appendTurn('s_hook_1', 'user', 'investigate the slack reaction noise', dir);
  // The FTS mirror write is deferred off the reply tick (see sessions.mjs) —
  // flush a few ticks so the fire-and-forget write-through lands before recall.
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  const out = recall('reaction', { configDir: dir, scope: ['sessions'] });
  assert.ok(out.hits.length >= 1, `no session hit; got ${JSON.stringify(out.hits)}`);
  assert.equal(out.hits[0].metadata.session_id, 's_hook_1');
  closeIndex(dir);
});

test('installSynthesized writes through to fts_skills', () => {
  const dir = tmp();
  openIndex(dir);
  installSynthesized({
    name: 'phaseA-hook-skill',
    description: 'Hook test fixture',
    body: '## When to use\nWhen testing the FTS5 write-through.\n',
    sourceTask: 't_test',
  }, dir);
  const out = recall('write-through', { configDir: dir, scope: ['skills'] });
  assert.ok(out.hits.length >= 1, `no skill hit; got ${JSON.stringify(out.hits)}`);
  closeIndex(dir);
});

test('trajectory_store.put writes through to fts_trajectories', async () => {
  const dir = tmp();
  openIndex(dir);
  await trajPut({
    taskId: 't_hook', agentName: 'a', workerProvider: 'anthropic',
    workerModel: 'm', startedAt: 1, endedAt: 2,
    systemPrompt: '', userMessages: [],
    turns: [{ turnIdx: 0, role: 'assistant',
      content: 'fts trajectory write-through verification phrase', toolCalls: [] }],
    finalAnswer: 'fts trajectory write-through verification phrase',
    outcome: 'done',
  }, { configDir: dir });
  const out = recall('verification', { configDir: dir, scope: ['trajectories'] });
  assert.ok(out.hits.length >= 1, `no trajectory hit; got ${JSON.stringify(out.hits)}`);
  assert.equal(out.hits[0].metadata.outcome, 'done');
  closeIndex(dir);
});

test('appendTurn still succeeds when index_db is unwritable', () => {
  const dir = tmp();
  // No openIndex call → indexSessionTurn falls into the lazy-open
  // path; we then forcibly close so the next write hits a closed db
  // and must be swallowed by the try/catch.
  openIndex(dir);
  closeIndex(dir);
  // Replace the db file with a directory so reopen throws.
  fs.unlinkSync(path.join(dir, 'index.db'));
  fs.mkdirSync(path.join(dir, 'index.db'));
  // appendTurn must NOT throw (invariant: session writes never break).
  appendTurn('s_resilient', 'user', 'this must succeed', dir);
  fs.rmSync(path.join(dir, 'index.db'), { recursive: true, force: true });
});
