// tests/f-workflow-run-request.test.mjs
//
// runDeclarativeRequest bridges a posted workflow definition + daemon config
// into a safe run: caps come from config (http SSRF-guarded + the configured
// llm provider), never from the workflow, so a posted workflow can't spawn a
// process or reach an ungranted capability. Backs POST /workflows/run.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runDeclarativeRequest } from '../workflow/run_request.mjs';

test('runs a declarative workflow with config-derived http + llm caps', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => 'page text' });
  const provider = { name: 'fake', async *sendMessage(m) { yield `S[${m.at(-1).content}]`; } };
  const cfg = { provider: 'fake', 'api-key': 'k', model: 'm' };
  const def = {
    nodes: [
      { id: 'page', type: 'http', config: { url: 'http://93.184.216.34/' } },
      { id: 'sum', type: 'llm', config: { prompt: 'sum: {{page.body}}' } },
    ],
  };
  const out = await runDeclarativeRequest(def, cfg, { fetchImpl, providerLookup: () => provider });
  assert.equal(out.success, true);
  assert.equal(out.session.sum, 'S[sum: page text]');
  assert.deepEqual(out.results.map((r) => r.id), ['page', 'sum']);
  assert.ok(out.results.every((r) => r.status === 'success'));
});

test('a malformed definition throws a WF_ error (caller maps to 400)', async () => {
  await assert.rejects(() => runDeclarativeRequest({ nodes: [] }, {}), (e) => String(e.code).startsWith('WF_'));
});

test('the llm node type is NOT granted when no provider resolves', async () => {
  const def = { nodes: [{ id: 'x', type: 'llm', config: { prompt: 'hi' } }] };
  await assert.rejects(() => runDeclarativeRequest(def, {}, { providerLookup: () => null }), /unknown node type "llm"/);
});

test('shell/process node types are never granted by the daemon bridge', async () => {
  const def = { nodes: [{ id: 'x', type: 'shell', config: { command: 'rm -rf /' } }] };
  await assert.rejects(() => runDeclarativeRequest(def, {}, { providerLookup: () => null }), /unknown node type "shell"/);
});
