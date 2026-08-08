// tests/f-recall-tool-hybrid.test.mjs
//
// Activation of hybrid recall: the agent-facing recall TOOL embeds the query
// (when cfg.recall.embeddings is enabled) and passes the vector to index_db so
// candidates re-rank by semantic similarity. Default/off → pure FTS5, unchanged.
// `pompos index embed` backfills doc vectors (no-op when off).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openIndex, closeIndex, indexSessionTurn, backfillEmbeddings } from '../mas/index_db.mjs';
import { __setEmbedder } from '../mas/embedder.mjs';
import * as recallTool from '../mas/tools/recall.mjs';

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-rth-'));

// Explicit content/query → vector map so cosine ordering is deterministic.
const MAP = {
  'shared topic about cats': [1, 0, 0],
  'shared topic about dogs': [0, 1, 0],
  'shared topic about cars': [0, 0, 1],
  'shared topic': [0, 1, 0], // the query points at "dogs"
};
const fakeVec = (t) => Float32Array.from(MAP[t] || [0, 0, 0]);

function seed(dir) {
  openIndex(dir);
  indexSessionTurn({ session_id: 's_cats', turn_idx: 0, role: 'user', ts: 1, content: 'shared topic about cats' }, dir);
  indexSessionTurn({ session_id: 's_dogs', turn_idx: 0, role: 'user', ts: 2, content: 'shared topic about dogs' }, dir);
  indexSessionTurn({ session_id: 's_cars', turn_idx: 0, role: 'user', ts: 3, content: 'shared topic about cars' }, dir);
}

test('recall tool re-ranks by embedding similarity when enabled', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'),
    JSON.stringify({ recall: { embeddings: { enabled: true, provider: 'ollama' } } }));
  __setEmbedder({ id: 'fake', dims: 3, embed: async (texts) => texts.map(fakeVec) });
  try {
    seed(dir);
    await backfillEmbeddings(dir, { recall: { embeddings: { enabled: true, provider: 'ollama' } } });
    const res = await recallTool.exec({ query: 'shared topic', scope: ['sessions'], k: 3 }, { configDir: dir });
    assert.equal(res.ok, true);
    assert.equal(res.hits[0].metadata.session_id, 's_dogs',
      `semantic winner should be s_dogs; got ${res.hits.map((h) => h.metadata.session_id).join(',')}`);
  } finally {
    __setEmbedder(undefined);
    closeIndex(dir);
  }
});

test('recall tool is pure FTS when embeddings are not configured', async () => {
  const dir = tmp();
  seed(dir); // no config.json → embeddings off
  const res = await recallTool.exec({ query: 'shared topic', scope: ['sessions'], k: 3 }, { configDir: dir });
  assert.equal(res.ok, true);
  assert.equal(res.hits.length, 3, 'all lexical matches returned, no embedding path');
  closeIndex(dir);
});

test('`index embed` reports 0 embedded when the feature is off', () => {
  const dir = tmp();
  openIndex(dir);
  indexSessionTurn({ session_id: 's1', turn_idx: 0, role: 'user', ts: 1, content: 'hello world' }, dir);
  closeIndex(dir);
  const r = spawnSync(process.execPath, [CLI, 'index', 'embed'], {
    env: { ...process.env, POMPOS_CONFIG_DIR: dir }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, `index embed should exit 0; stderr=${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout), { ok: true, embedded: 0 });
});
