// tests/f-phase2-scoped-recall.test.mjs
//
// Phase 2 (wave-B, scoped-recall): recall was per-configDir GLOBAL — every
// session/skill/trajectory/memory in a configDir was recallable from any turn,
// so in a multi-agent / multi-workspace setup one agent's docs leaked into
// another's prompt. This adds an OPT-IN `scope` dimension:
//   - index writers accept an optional `scope` (default 'global' — existing
//     callers unchanged).
//   - recall({ scope }) restricts to the given scope(s) + always-allowed
//     'global'. Omitting scope behaves EXACTLY as before (no filter).
//   - the schema-version bump rebuilds an old-shaped index (no doc_scope
//     column) from the on-disk sources with no data loss.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  openIndex, closeIndex, indexSessionTurn, indexMemory, recall,
} from '../mas/index_db.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc-scoped-'));

test('(a) recall({ scope }) returns only the matching scope (+ global), not the other', () => {
  const dir = tmp();
  openIndex(dir);
  indexMemory({ topic: 'a-note', kind: 'episodic', content: 'shared widget topic alpha' }, dir, { docScope: 'agent:alpha' });
  indexMemory({ topic: 'b-note', kind: 'episodic', content: 'shared widget topic beta' }, dir, { scope: 'agent:beta' });

  const out = recall('widget', { configDir: dir, docScope: 'agent:alpha' });
  const topics = out.hits.map((h) => h.metadata.topic).sort();
  assert.deepEqual(topics, ['a-note'], `only alpha's doc should surface; got ${JSON.stringify(topics)}`);
  closeIndex(dir);
});

test('(a2) recall accepts an array of scopes', () => {
  const dir = tmp();
  openIndex(dir);
  indexMemory({ topic: 'a-note', kind: 'episodic', content: 'shared widget topic alpha' }, dir, { docScope: 'agent:alpha' });
  indexMemory({ topic: 'b-note', kind: 'episodic', content: 'shared widget topic beta' }, dir, { scope: 'agent:beta' });
  indexMemory({ topic: 'c-note', kind: 'episodic', content: 'shared widget topic gamma' }, dir, { scope: 'agent:gamma' });

  const out = recall('widget', { configDir: dir, docScope: ['agent:alpha', 'agent:beta'] });
  const topics = out.hits.map((h) => h.metadata.topic).sort();
  assert.deepEqual(topics, ['a-note', 'b-note'], `got ${JSON.stringify(topics)}`);
  closeIndex(dir);
});

test('(b) recall with NO scope returns both docs (byte-stable global behavior)', () => {
  const dir = tmp();
  openIndex(dir);
  indexMemory({ topic: 'a-note', kind: 'episodic', content: 'shared widget topic alpha' }, dir, { docScope: 'agent:alpha' });
  indexMemory({ topic: 'b-note', kind: 'episodic', content: 'shared widget topic beta' }, dir, { scope: 'agent:beta' });

  const out = recall('widget', { configDir: dir });
  const topics = out.hits.map((h) => h.metadata.topic).sort();
  assert.deepEqual(topics, ['a-note', 'b-note'], `no scope => no filter; got ${JSON.stringify(topics)}`);
  // Hit shape stays byte-stable: no doc_scope leakage into metadata.
  for (const h of out.hits) {
    assert.deepEqual(Object.keys(h).sort(), ['bm25', 'metadata', 'rank', 'scope', 'snippet'].sort());
    assert.ok(!('doc_scope' in h.metadata), 'doc_scope must not leak into metadata');
    assert.ok(!('rowid' in h.metadata), 'rowid must not leak into metadata');
  }
  closeIndex(dir);
});

test('(c) a global-scoped doc is always returned even when a narrow scope is requested', () => {
  const dir = tmp();
  openIndex(dir);
  indexMemory({ topic: 'a-note', kind: 'episodic', content: 'shared widget topic alpha' }, dir, { docScope: 'agent:alpha' });
  indexMemory({ topic: 'g-note', kind: 'episodic', content: 'shared widget topic global' }, dir); // default global
  indexMemory({ topic: 'b-note', kind: 'episodic', content: 'shared widget topic beta' }, dir, { scope: 'agent:beta' });

  const out = recall('widget', { configDir: dir, docScope: 'agent:alpha' });
  const topics = out.hits.map((h) => h.metadata.topic).sort();
  assert.deepEqual(topics, ['a-note', 'g-note'], `alpha + global always; got ${JSON.stringify(topics)}`);
  closeIndex(dir);
});

test('(d) schema-version bump rebuilds an old-shaped index without losing source docs', () => {
  const dir = tmp();
  // Simulate an OLD (pre-scope) index: create v1-shaped FTS tables with NO
  // doc_scope column and stamp schema_version=1, then seed the on-disk source
  // (a session JSONL) so reindexAll can repopulate it.
  fs.mkdirSync(dir, { recursive: true });
  const sessDir = path.join(dir, 'sessions');
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessDir, 'old_session.jsonl'),
    JSON.stringify({ role: 'user', ts: 1, content: 'legacy widget content survives the rebuild' }) + '\n',
  );

  const db = new Database(path.join(dir, 'index.db'));
  db.exec(`
    CREATE VIRTUAL TABLE fts_sessions USING fts5(
      content, session_id UNINDEXED, turn_idx UNINDEXED, role UNINDEXED, ts UNINDEXED
    );
    CREATE VIRTUAL TABLE fts_skills USING fts5(
      content, skill_name UNINDEXED, trained_by UNINDEXED, group_name UNINDEXED
    );
    CREATE VIRTUAL TABLE fts_trajectories USING fts5(
      content, trajectory_id UNINDEXED, agent UNINDEXED, outcome UNINDEXED
    );
    CREATE VIRTUAL TABLE fts_memories USING fts5(
      content, topic UNINDEXED, kind UNINDEXED
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta(key,value) VALUES('schema_version','1');
  `);
  // A stale row that lives ONLY in the FTS table (not in the source) — after a
  // clean rebuild it should be gone; the source-backed row must survive.
  db.prepare(`INSERT INTO fts_sessions(content, session_id, turn_idx, role, ts) VALUES (?,?,?,?,?)`)
    .run('stale row not backed by any source file', 's_stale', 0, 'user', 0);
  db.close();

  // openIndex must detect the stale version and rebuild from source.
  openIndex(dir);

  // The old FTS table now has a doc_scope column (schema migrated).
  const cols = openIndex(dir).prepare(`PRAGMA table_info(fts_sessions)`).all().map((c) => c.name);
  assert.ok(cols.includes('doc_scope'), `migrated table must have doc_scope; got ${cols.join(',')}`);

  // Source-backed row survives the rebuild, treated as global -> recallable
  // both un-scoped and scoped.
  const outAll = recall('legacy', { configDir: dir, scope: ['sessions'] });
  assert.equal(outAll.hits.length, 1, `source row must survive rebuild; got ${JSON.stringify(outAll.hits)}`);
  assert.equal(outAll.hits[0].metadata.session_id, 'old_session');

  const outScoped = recall('legacy', { configDir: dir, docScope: 'agent:whoever' });
  assert.equal(outScoped.hits.length, 1, 'rebuilt rows are global -> visible under any scope');

  // The stale (source-less) FTS row is gone after the clean rebuild.
  const outStale = recall('stale', { configDir: dir, scope: ['sessions'] });
  assert.equal(outStale.hits.length, 0, 'stale source-less FTS row dropped by clean rebuild');
  closeIndex(dir);
});
