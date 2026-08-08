// tests/f-index-rebuild-cli.test.mjs — the `pompos index rebuild` CLI command.
//
// mas/index_db.mjs documents recovery "via pompos index rebuild" and the
// doctor/failure-log points operators to it, but the `index` subcommand was
// absent from lib/args.mjs SUBCOMMANDS, so following the code's own
// instructions yielded the generic "unknown subcommand" usage + exit 2.
// These tests pin that bug and the new command's contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = process.cwd();
const CLI = path.join(REPO_ROOT, 'cli.mjs');

function tmpCfg(prefix = 'lc-index-rebuild-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args, cfgDir, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, POMPOS_CONFIG_DIR: cfgDir, ...env },
  });
}

// (a) `index rebuild` on an empty corpus succeeds (exit 0) and prints a
//     counts summary. reindexAll repopulates from disk — an empty corpus
//     yields zero counts but must NOT error.
test('index rebuild on an empty corpus exits 0 and prints a counts summary', () => {
  const dir = tmpCfg();
  const r = runCli(['index', 'rebuild'], dir);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.ok(out.counts && typeof out.counts === 'object', 'counts object present');
  assert.equal(out.counts.sessions, 0, 'empty corpus → zero sessions');
  assert.equal(out.counts.skills, 0, 'empty corpus → zero skills');
  assert.equal(out.counts.memories, 0, 'empty corpus → zero memories');
  // The index.db file was created on disk by reindexAll/openIndex.
  assert.ok(fs.existsSync(path.join(dir, 'index.db')), 'index.db created');
});

// (a, populated) reindexAll repopulates from the on-disk corpus, so the
//     reported counts reflect what was indexed.
test('index rebuild repopulates counts from the on-disk corpus', () => {
  const dir = tmpCfg();
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'sessions', 's1.jsonl'),
    JSON.stringify({ role: 'user', content: 'deploy the canarybuild', ts: 1 }) + '\n',
  );
  fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'skills', 'deploy-flow.md'),
    '---\nname: deploy-flow\ntrained_by: user\ngroup: deploy\n---\n\ncanarybuild rollout steps',
  );
  const r = runCli(['index', 'rebuild'], dir);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.counts.sessions, 1, 'one session turn indexed');
  assert.equal(out.counts.skills, 1, 'one skill indexed');
});

// (b) `index` with no sub exits 2 with an index-specific usage message
//     (distinct from the generic "unknown subcommand" default).
test('index with no sub exits 2 with an index-specific usage message', () => {
  const dir = tmpCfg();
  const r = runCli(['index'], dir);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stdout=${r.stdout}`);
  assert.match(r.stderr, /Usage: pompos index <rebuild\|embed>/);
});

// (b) a bad sub is rejected the same way.
test('index with a bad sub exits 2 with an index-specific usage message', () => {
  const dir = tmpCfg();
  const r = runCli(['index', 'bogus'], dir);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stdout=${r.stdout}`);
  assert.match(r.stderr, /Usage: pompos index <rebuild\|embed>/);
});

// (d) reindexAll must walk EVERYTHING that is indexed at write time. It
// covered sessions, skills and core/episodic memories but not trajectories or
// the USER model — so the documented recovery path destroyed exactly the
// recall data a long-running install has most of. Observed live: a reindex
// dropped fts_trajectories from 1451 rows to 0 and lost the USER memory row
// while the JSONL and USER.md sources sat intact on disk.

test('index rebuild repopulates trajectories and the USER model from disk', async () => {
  const dir = tmpCfg();

  // A trajectory exactly as trajectory_store.put lays it out on disk.
  const day = path.join(dir, 'trajectories', '2026-08-01');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, '01TESTTRAJECTORYID00000000.jsonl'), JSON.stringify({
    id: '01TESTTRAJECTORYID00000000',
    agentName: 'backend-dev',
    outcome: 'done',
    finalAnswer: 'rotated the flux capacitor',
    turns: [{ content: 'user asked about the flux capacitor' }],
  }) + '\n');

  // The USER model exactly as user_modeler writes it.
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'USER.md'), '- prefers terse answers\n');

  const r = runCli(['index', 'rebuild'], dir);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.counts.trajectories, 1,
    'a trajectory on disk must survive a rebuild — write-time indexing alone means rebuild = lose');
  assert.equal(out.counts.memories, 1, 'USER.md must be re-indexed');

  // The reindexed row must be reachable by content, same as a write-time row.
  const { openIndex } = await import('../mas/index_db.mjs');
  const db = openIndex(dir);
  const traj = db.prepare("SELECT agent, outcome FROM fts_trajectories WHERE fts_trajectories MATCH 'flux'").all();
  assert.equal(traj.length, 1);
  assert.equal(traj[0].agent, 'backend-dev');
  assert.equal(traj[0].outcome, 'done');
  const user = db.prepare("SELECT topic, kind FROM fts_memories WHERE topic='USER'").get();
  assert.deepEqual(user, { topic: 'USER', kind: 'user_model' });
});
