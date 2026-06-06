// P1 — every advertised OpenAI-compatible provider can drive tool-use, so it
// can be an agent / team member / trainer (not just a chat provider).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveToolUseAdapter } from '../mas/provider_adapters.mjs';

test('OpenAI-compat builtins resolve to a tool-use adapter', async () => {
  for (const p of ['openrouter', 'groq', 'deepseek', 'together']) {
    const a = await resolveToolUseAdapter(p);
    assert.equal(typeof a.callOnce, 'function', `${p} adapter must expose callOnce`);
  }
});

test('the bound adapter targets the provider baseUrl', async () => {
  const a = await resolveToolUseAdapter('groq');
  let url = null;
  const fetchImpl = async (u) => { url = String(u); throw new Error('stop-after-capture'); };
  await a.callOnce({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [], model: 'llama-3', apiKey: 'k', fetchImpl,
  }).catch(() => { /* expected */ });
  assert.ok(url && url.includes('api.groq.com'), `expected groq host, got ${url}`);
});

test('a non-tool-use provider still throws a clear error', async () => {
  await assert.rejects(
    () => resolveToolUseAdapter('ollama'),
    /does not support text completion|PROVIDER_ADAPTER_UNKNOWN/,
  );
});
