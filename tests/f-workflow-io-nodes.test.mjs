// tests/f-workflow-io-nodes.test.mjs
//
// Side-effecting workflow node types (roadmap #5, I/O slice): http (SSRF-
// guarded) and llm (provider-backed), granted via capability injection. A
// workflow can only reach them when the runner passes them as caps.

import test from 'node:test';
import assert from 'node:assert/strict';
import { httpNode, llmNode, buildCaps } from '../workflow/builtin_caps.mjs';
import { runWorkflow } from '../workflow/declarative.mjs';

test('http node fetches and parses JSON through an injected fetch', async () => {
  const fetchImpl = async (url, init) => ({
    ok: true, status: 200, text: async () => JSON.stringify({ url, method: init.method }),
  });
  const node = httpNode({ fetchImpl });
  const out = await node({ url: 'http://93.184.216.34/api', json: true }, {});
  assert.equal(out.status, 200);
  assert.equal(out.json.url, 'http://93.184.216.34/api');
  assert.equal(out.json.method, 'GET');
});

test('http node refuses an SSRF target (loopback) before fetching', async () => {
  let fetched = false;
  const node = httpNode({ fetchImpl: async () => { fetched = true; return { ok: true, status: 200, text: async () => '' }; } });
  await assert.rejects(() => node({ url: 'http://127.0.0.1/secret' }, {}), /SSRF|blocked|loopback/i);
  assert.equal(fetched, false, 'must not fetch a blocked url');
});

test('llm node concatenates the provider stream into the assistant text', async () => {
  const provider = {
    name: 'fake',
    async *sendMessage(messages) {
      assert.equal(messages.at(-1).content, 'summarize this');
      yield 'a'; yield 'b'; yield 'c';
    },
  };
  const node = llmNode({ provider });
  const out = await node({ prompt: 'summarize this' }, {});
  assert.equal(out, 'abc');
});

test('a declarative workflow chains http → llm via granted caps', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => 'the raw page text' });
  const provider = {
    name: 'fake',
    async *sendMessage(messages) { yield `SUMMARY[${messages.at(-1).content}]`; },
  };
  const caps = buildCaps({ http: { fetchImpl }, llm: { provider } });
  const def = {
    nodes: [
      { id: 'page', type: 'http', config: { url: 'http://93.184.216.34/', json: false } },
      { id: 'summary', type: 'llm', config: { prompt: 'summarize: {{page.body}}' } },
    ],
  };
  const r = await runWorkflow(def, { caps });
  assert.equal(r.success, true);
  assert.equal(r.session.summary, 'SUMMARY[summarize: the raw page text]');
});

test('a workflow cannot use an I/O node type that was not granted', async () => {
  const def = { nodes: [{ id: 'x', type: 'http', config: { url: 'http://93.184.216.34/' } }] };
  await assert.rejects(() => runWorkflow(def), /unknown node type "http"/);
});
