// tests/f-hybrid-recall.test.mjs
//
// Hybrid recall (roadmap #4): blend FTS5 bm25 with embedding cosine. The blend
// is OPT-IN and additive — recall() stays synchronous and byte-stable when no
// query vector is supplied (the $0/default path). When a caller (which is
// already async) passes opts.queryVector and docs have stored embeddings,
// recall re-ranks the FTS candidates by a fused bm25 + cosine score. No native
// dependency: vectors are stored as BLOBs and cosine runs in JS.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIndex, closeIndex, indexSessionTurn, recall, backfillEmbeddings } from '../mas/index_db.mjs';
import { __setEmbedder } from '../mas/embedder.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-hyb-'));

// Deterministic fake embedder: a doc/query maps to a one-hot vector by the
// animal keyword it contains, so cosine similarity is controllable in a test.
const VECS = { cats: [1, 0, 0], dogs: [0, 1, 0], cars: [0, 0, 1] };
const fakeVec = (t) => {
  for (const k of Object.keys(VECS)) if (String(t).includes(k)) return Float32Array.from(VECS[k]);
  return Float32Array.from([0, 0, 0]);
};

function seed(dir) {
  openIndex(dir);
  indexSessionTurn({ session_id: 's_cats', turn_idx: 0, role: 'user', ts: 1, content: 'shared topic about cats' }, dir);
  indexSessionTurn({ session_id: 's_dogs', turn_idx: 0, role: 'user', ts: 2, content: 'shared topic about dogs' }, dir);
  indexSessionTurn({ session_id: 's_cars', turn_idx: 0, role: 'user', ts: 3, content: 'shared topic about cars' }, dir);
}

test('default recall (no queryVector) is unchanged: bm25 order, byte-stable hit shape', () => {
  const dir = tmp();
  seed(dir);
  const out = recall('shared topic', { configDir: dir, scope: ['sessions'] });
  assert.equal(out.hits.length, 3, 'all three lexical matches returned');
  for (const h of out.hits) {
    assert.deepEqual(Object.keys(h).sort(), ['bm25', 'metadata', 'rank', 'scope', 'snippet'].sort(),
      'hit shape must stay {scope,rank,bm25,snippet,metadata} — no rowid leakage');
    assert.ok(!('rowid' in h.metadata), 'rowid must not leak into metadata');
  }
  closeIndex(dir);
});

test('with a query vector + stored embeddings, the semantically-closest doc ranks first', async () => {
  const dir = tmp();
  __setEmbedder({ id: 'fake', dims: 3, embed: async (texts) => texts.map(fakeVec) });
  try {
    seed(dir);
    // Backfill doc embeddings from FTS content via the fake embedder.
    const n = await backfillEmbeddings(dir, { recall: { embeddings: { enabled: true, provider: 'ollama' } } });
    assert.equal(n, 3, 'three docs embedded');
    // Query vector points at "dogs" — that doc must win even though all three
    // share the same lexical match.
    const qvec = fakeVec('dogs');
    const out = recall('shared topic', { configDir: dir, scope: ['sessions'], queryVector: qvec });
    assert.equal(out.hits[0].metadata.session_id, 's_dogs',
      `semantic winner should be s_dogs; got order ${out.hits.map((h) => h.metadata.session_id).join(',')}`);
  } finally {
    __setEmbedder(undefined);
    closeIndex(dir);
  }
});

test('backfillEmbeddings is a no-op when embeddings are disabled (default)', async () => {
  const dir = tmp();
  seed(dir);
  const n = await backfillEmbeddings(dir, {}); // no cfg.recall.embeddings
  assert.equal(n, 0, 'nothing embedded when the feature is off');
  // recall with a queryVector but no stored embeddings falls back to bm25 order.
  const out = recall('shared topic', { configDir: dir, scope: ['sessions'], queryVector: Float32Array.from([0, 1, 0]) });
  assert.equal(out.hits.length, 3, 'still returns FTS hits — vector path degrades gracefully');
  closeIndex(dir);
});
