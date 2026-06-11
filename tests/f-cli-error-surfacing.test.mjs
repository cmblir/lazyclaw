// tests/f-cli-error-surfacing.test.mjs — the keyless CLI providers report
// API/turn failures on STDOUT as structured events, not on stderr. Codex in
// particular prints only "Reading additional input from stdin…" to stderr
// while the real reason ("The 'gpt-5-codex' model is not supported when using
// Codex with a ChatGPT account.") rides a {"type":"error"} NDJSON event the
// provider used to drop. These tests pin the unwrapping so a model/plan
// mismatch surfaces an actionable message instead of an empty reply.

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEventError, resolveModel } from '../providers/codex_cli.mjs';

test('codex extractEventError unwraps a nested error event', () => {
  const ev = {
    type: 'error',
    message: JSON.stringify({
      type: 'error',
      status: 400,
      error: { type: 'invalid_request_error', message: "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account." },
    }),
  };
  assert.equal(extractEventError(ev), "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.");
});

test('codex extractEventError handles turn.failed and plain strings', () => {
  assert.equal(
    extractEventError({ type: 'turn.failed', error: { message: 'boom' } }),
    'boom',
  );
  // A non-JSON message string passes through verbatim.
  assert.equal(extractEventError({ type: 'error', message: 'rate limited' }), 'rate limited');
});

test('codex extractEventError ignores non-error events', () => {
  assert.equal(extractEventError({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }), '');
  assert.equal(extractEventError({ type: 'turn.completed' }), '');
  assert.equal(extractEventError(null), '');
});

test('codex resolveModel no longer aliases to the ChatGPT-rejected gpt-5-codex', () => {
  // The old alias map turned "codex"/"gpt-codex" into "gpt-5-codex"; with a
  // ChatGPT-account login that model is rejected, so the alias is gone. A
  // non-gpt shorthand now drops to '' (no -m → codex uses the account default).
  assert.equal(resolveModel('codex'), '');
  assert.equal(resolveModel(''), '');
  // Explicit, real ids still pass through for users whose plan allows them
  // (any rejection now surfaces a clear error rather than being swallowed).
  assert.equal(resolveModel('gpt-codex'), 'gpt-codex');
  assert.equal(resolveModel('gpt-5.5'), 'gpt-5.5');
});
