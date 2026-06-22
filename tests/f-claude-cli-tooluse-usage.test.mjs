// The claude-cli TOOL-USE adapter (the default subscription agentic path: chat,
// every mention-router team turn, per-turn trainer) reported NO usage, so 100%
// of its spend was invisible to the daemon cost cap. Usage rides the `assistant`
// event (the `result` event reports zero tokens under streaming), with cost on
// the result event — same as the streaming sibling. callOnce must surface it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callOnce } from '../providers/tool_use/claude_cli.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');

test('claude-cli tool-use callOnce surfaces usage from the assistant event + cost from result', async () => {
  const r = await callOnce({ messages: [{ role: 'user', content: 'hi' }], bin: FAKE });
  assert.equal(r.kind, 'final');
  assert.equal(r.text, 'ok');
  assert.ok(r.usage, 'usage is reported (was previously absent)');
  assert.equal(r.usage.inputTokens, 2, 'from the assistant event, not the zero-usage result');
  assert.equal(r.usage.outputTokens, 2);
  assert.equal(r.usage.cacheCreationInputTokens, 3189);
  assert.equal(r.usage.cacheReadInputTokens, 0);
  assert.equal(r.usage.totalCostUsd, 0.0123, 'cost from the result event');
});

test('claude-cli tool-use callOnce returns truncated (not a thrown exit error) on a max-turns cut', async () => {
  // The fake emits a result subtype error_max_turns + exits non-zero; the
  // adapter must surface it as truncated so agent_turn stops cleanly with
  // stoppedBy:'truncated' instead of a confusing "claude CLI exit 1" error.
  const r = await callOnce({ messages: [{ role: 'user', content: 'please ERRMAXTURNS' }], bin: FAKE });
  assert.equal(r.kind, 'final');
  assert.equal(r.truncated, true);
  assert.equal(r.text, 'partial');
});
