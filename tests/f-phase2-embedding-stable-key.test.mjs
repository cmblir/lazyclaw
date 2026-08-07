// tests/f-phase2-embedding-stable-key.test.mjs
//
// Regression: hybrid-recall embeddings used to be keyed by the FTS5 IMPLICIT
// rowid. FTS5 rowids are NOT stable across delete-then-insert (every skill/
// trajectory/memory save deletes-then-inserts; reindexAll rebuilds from
// scratch), so a stored vector silently ended up pointing at a DIFFERENT doc
// after any re-index — blendHybrid then returned confidently-WRONG cosine
// scores. Fix: key embeddings by each doc's STABLE natural key. These tests
// prove the vector<->doc association survives rowid churn.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openIndex, closeIndex, indexSessionTurn, indexSkill,
  recall, backfillEmbeddings, reindexAll,
} from '../mas/index_db.mjs';
import { __setEmbedder } from '../mas/embedder.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-esk-'));

// Deterministic fake embedder: one-hot by the animal keyword the text contains.
const VECS = { cats: [1, 0, 0], dogs: [0, 1, 0], cars: [0, 0, 1] };
const fakeVec = (t) => {
  for (const k of Object.keys(VECS)) if (String(t).includes(k)) return Float32Array.from(VECS[k]);
  return Float32Array.from([0, 0, 0]);
};
const embCfg = { recall: { embeddings: { enabled: true, provider: 'ollama' } } };

test('(a) re-saving a doc churns its FTS rowid, but its vector still joins by stable key', async () => {
  const dir = tmp();
  __setEmbedder({ id: 'fake', dims: 3, embed: async (texts) => texts.map(fakeVec) });
  try {
    openIndex(dir);
    // Skills delete-then-insert on every save. Re-saving a NON-last row makes
    // FTS5 hand it a fresh (higher) rowid — under the OLD rowid-keyed scheme its
    // vector (stored under the old rowid) would no longer join, so it silently
    // loses its semantic boost (or worse, mis-joins after a later rebuild).
    indexSkill({ skill_name: 'k_cats', trained_by: 'user', group_name: 'g', content: 'topic about cats' }, dir);
    indexSkill({ skill_name: 'k_dogs', trained_by: 'user', group_name: 'g', content: 'topic about dogs' }, dir);
    indexSkill({ skill_name: 'k_cars', trained_by: 'user', group_name: 'g', content: 'topic about cars' }, dir);
    const n = await backfillEmbeddings(dir, embCfg);
    assert.equal(n, 3, 'three skills embedded');

    // Sanity: before any churn, a cats-pointing query wins k_cats.
    let out = recall('topic', { configDir: dir, scope: ['skills'], queryVector: fakeVec('cats') });
    assert.equal(out.hits[0].metadata.skill_name, 'k_cats', 'pre-churn: cats query -> k_cats');

    // RE-SAVE k_cats (the queried doc, and NOT the last row) — its rowid churns.
    indexSkill({ skill_name: 'k_cats', trained_by: 'user', group_name: 'g', content: 'topic about cats' }, dir);

    // k_cats's vector must STILL join to k_cats by its stable natural key, so a
    // cats-pointing query still ranks it first — no lost/mis-joined embedding.
    out = recall('topic', { configDir: dir, scope: ['skills'], queryVector: fakeVec('cats') });
    assert.equal(out.hits[0].metadata.skill_name, 'k_cats',
      `post-churn cats query must still win k_cats; got ${out.hits.map((h) => h.metadata.skill_name).join(',')}`);
  } finally {
    __setEmbedder(undefined);
    closeIndex(dir);
  }
});

test('(b) a full reindexAll cleanly drops vectors, then a re-backfill re-associates by stable key (never mis-joins)', async () => {
  const dir = tmp();
  __setEmbedder({ id: 'fake', dims: 3, embed: async (texts) => texts.map(fakeVec) });
  try {
    // Seed from the on-disk source of truth so reindexAll can rebuild it.
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sessions', 's_cats.jsonl'),
      JSON.stringify({ role: 'user', content: 'topic about cats', ts: 1 }) + '\n');
    fs.writeFileSync(path.join(dir, 'sessions', 's_dogs.jsonl'),
      JSON.stringify({ role: 'user', content: 'topic about dogs', ts: 2 }) + '\n');
    reindexAll(dir);
    await backfillEmbeddings(dir, embCfg);

    // reindexAll rebuilds the db from scratch (rebuild() unlinks the file), so
    // the vectors are cleanly DROPPED — not silently mis-joined to new rowids.
    reindexAll(dir);
    const dropped = recall('topic', { configDir: dir, scope: ['sessions'], queryVector: fakeVec('dogs') });
    assert.equal(dropped.hits.length, 2, 'both docs still recallable after reindex (bm25 fallback, no throw)');

    // Re-backfilling re-keys by the STABLE (session_id, turn_idx) natural key —
    // so each vector lands back on its own doc. dogs query must win s_dogs...
    const n = await backfillEmbeddings(dir, embCfg);
    assert.equal(n, 2, 'both docs re-embedded after reindex');
    const out = recall('topic', { configDir: dir, scope: ['sessions'], queryVector: fakeVec('dogs') });
    assert.equal(out.hits[0].metadata.session_id, 's_dogs',
      `after reindex+backfill, dogs query must win s_dogs; got ${out.hits.map((h) => h.metadata.session_id).join(',')}`);
    // ...and a cats query must win s_cats — proving no cross-doc swap.
    const out2 = recall('topic', { configDir: dir, scope: ['sessions'], queryVector: fakeVec('cats') });
    assert.equal(out2.hits[0].metadata.session_id, 's_cats',
      `after reindex+backfill, cats query must win s_cats; got ${out2.hits.map((h) => h.metadata.session_id).join(',')}`);
  } finally {
    __setEmbedder(undefined);
    closeIndex(dir);
  }
});

test('(c) a hit with no embedding under its key falls back to its FTS score', async () => {
  const dir = tmp();
  __setEmbedder({ id: 'fake', dims: 3, embed: async (texts) => texts.map(fakeVec) });
  try {
    openIndex(dir);
    indexSkill({ skill_name: 'k_cats', trained_by: 'user', group_name: 'g', content: 'topic about cats' }, dir);
    await backfillEmbeddings(dir, embCfg);
    // Add a NEW skill AFTER the backfill — it has no stored vector yet.
    indexSkill({ skill_name: 'k_dogs', trained_by: 'user', group_name: 'g', content: 'topic about dogs' }, dir);

    // Blend must not throw and must still return both hits; the un-embedded
    // k_dogs keeps its bm25 standing (vecNorm 0), never mis-joining a vector.
    const out = recall('topic', { configDir: dir, scope: ['skills'], queryVector: fakeVec('dogs') });
    const names = out.hits.map((h) => h.metadata.skill_name).sort();
    assert.deepEqual(names, ['k_cats', 'k_dogs'], 'both hits returned; un-embedded doc not dropped');
  } finally {
    __setEmbedder(undefined);
    closeIndex(dir);
  }
});

test('legacy rowid-keyed vectors are dropped on the schema-version migration', async () => {
  const dir = tmp();
  const Database = (await import('better-sqlite3')).default;
  // Simulate an OLD (v2) index: FTS tables with doc_scope but the OLD
  // rowid-keyed embeddings table + stored version 2.
  const dbFile = path.join(dir, 'index.db');
  {
    const db = new Database(dbFile);
    db.exec(`
      CREATE VIRTUAL TABLE fts_skills USING fts5(
        content, skill_name UNINDEXED, trained_by UNINDEXED, group_name UNINDEXED, doc_scope UNINDEXED);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE embeddings (scope TEXT, rowid_ref INTEGER, vec BLOB, PRIMARY KEY (scope, rowid_ref));
      INSERT INTO meta(key,value) VALUES('schema_version','2');
    `);
    db.prepare(`INSERT INTO fts_skills(content, skill_name, trained_by, group_name, doc_scope)
                VALUES ('topic about cats','k_cats','user','g','global')`).run();
    db.prepare('INSERT INTO embeddings(scope, rowid_ref, vec) VALUES (?,?,?)')
      .run('skills', 1, Buffer.from(Float32Array.from([1, 0, 0]).buffer));
    db.close();
  }
  // openIndex sees the version drift and rebuilds (the migration). The old
  // rowid-keyed embeddings table is gone; the new one is doc_key-keyed + empty.
  openIndex(dir, { runIntegrityCheck: false });
  const db = (await import('better-sqlite3')).default;
  const probe = new db(dbFile, { readonly: true });
  const info = probe.prepare('PRAGMA table_info(embeddings)').all().map((c) => c.name);
  const rows = probe.prepare('SELECT COUNT(*) AS n FROM embeddings').get();
  probe.close();
  closeIndex(dir);
  assert.ok(info.includes('doc_key'), `embeddings must be re-keyed by doc_key; cols=${info.join(',')}`);
  assert.ok(!info.includes('rowid_ref'), 'stale rowid_ref column must be gone');
  assert.equal(rows.n, 0, 'stale rowid-keyed vectors must be dropped, not mis-joined');
});
