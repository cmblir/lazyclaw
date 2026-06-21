// tests/f-embedder.test.mjs
//
// The opt-in embedding source for hybrid recall. OFF by default (null → pure
// FTS5); lights up only when cfg.recall.embeddings.enabled and a source
// resolves. The $0 chat-subscription user has no source, so null is the norm.

import test from 'node:test';
import assert from 'node:assert/strict';
import { getEmbedder, __setEmbedder } from '../mas/embedder.mjs';

test('getEmbedder returns null when embeddings are not enabled', () => {
  assert.equal(getEmbedder({}), null);
  assert.equal(getEmbedder({ recall: {} }), null);
  assert.equal(getEmbedder({ recall: { embeddings: { enabled: false, provider: 'ollama' } } }), null);
});

test('getEmbedder returns null for an unknown provider or a keyless openai/gemini', () => {
  assert.equal(getEmbedder({ recall: { embeddings: { enabled: true, provider: 'nope' } } }), null);
  assert.equal(getEmbedder({ recall: { embeddings: { enabled: true, provider: 'openai' } } }), null, 'openai needs a key');
  assert.equal(getEmbedder({ recall: { embeddings: { enabled: true, provider: 'gemini' } } }), null, 'gemini needs a key');
});

test('getEmbedder resolves a keyless ollama embedder and an openai embedder with a key', () => {
  const ollama = getEmbedder({ recall: { embeddings: { enabled: true, provider: 'ollama' } } });
  assert.ok(ollama, 'ollama is keyless');
  assert.equal(ollama.dims, 768);
  assert.match(ollama.id, /^ollama\//);
  const openai = getEmbedder({ recall: { embeddings: { enabled: true, provider: 'openai', apiKey: 'sk-x' } } });
  assert.ok(openai);
  assert.equal(openai.dims, 1536);
});

test('openai embed() posts to the embeddings endpoint and returns Float32 vectors', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, body: JSON.parse(init.body), auth: init.headers.authorization };
    return { ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }] }) };
  };
  const emb = getEmbedder({ recall: { embeddings: { enabled: true, provider: 'openai', apiKey: 'sk-x' } } }, { fetchImpl });
  const vecs = await emb.embed(['hello', 'world']);
  assert.equal(vecs.length, 2);
  assert.ok(vecs[0] instanceof Float32Array);
  assert.deepEqual([...vecs[1]].map((x) => Math.round(x * 10) / 10), [0.4, 0.5, 0.6]);
  assert.match(seen.url, /\/embeddings/);
  assert.equal(seen.auth, 'Bearer sk-x');
  assert.deepEqual(seen.body.input, ['hello', 'world']);
});

test('ollama embed() posts one prompt per text', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body).prompt);
    return { ok: true, json: async () => ({ embedding: [1, 0, 0] }) };
  };
  const emb = getEmbedder({ recall: { embeddings: { enabled: true, provider: 'ollama' } } }, { fetchImpl });
  const vecs = await emb.embed(['a', 'b']);
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(vecs.length, 2);
  assert.ok(vecs[0] instanceof Float32Array);
});

test('__setEmbedder overrides resolution (test seam) and clears with undefined', () => {
  const fake = { id: 'fake/x', dims: 3, embed: async (t) => t.map(() => Float32Array.from([1, 2, 3])) };
  __setEmbedder(fake);
  assert.equal(getEmbedder({}), fake, 'override wins even with no config');
  __setEmbedder(undefined);
  assert.equal(getEmbedder({}), null, 'cleared back to default');
});
