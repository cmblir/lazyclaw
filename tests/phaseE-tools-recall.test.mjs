import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as recall from '../mas/tools/recall.mjs';

test('recall tool exposes v5 shape', () => {
  assert.equal(recall.TOOL.name, 'recall');
  assert.equal(recall.TOOL.category, 'learning');
  assert.equal(recall.TOOL.sensitive, false);
  assert.equal(typeof recall.TOOL.exec, 'function');
});

test('recall rejects empty query', async () => {
  const r = await recall.TOOL.exec({ query: '' });
  assert.equal(r.ok, false);
});

test('recall delegates to inject recallFn', async () => {
  let captured;
  const fakeRecall = async (q, opts) => { captured = { q, opts }; return { query: q, hits: [], latencyMs: 1 }; };
  recall.__setRecall(fakeRecall);
  const r = await recall.TOOL.exec({ query: 'hello', scope: ['skills'], k: 4 });
  assert.equal(r.ok, true);
  assert.equal(captured.q, 'hello');
  assert.deepEqual(captured.opts.scope, ['skills']);
  assert.equal(captured.opts.k, 4);
  recall.__setRecall(null);
});
