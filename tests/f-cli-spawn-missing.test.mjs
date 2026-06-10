// tests/f-cli-spawn-missing.test.mjs — a missing CLI binary must surface as
// a catchable per-provider CliMissingError, NOT an uncaughtException.
//
// Regression: spawn ENOENT arrives as an ASYNC ChildProcess 'error' event;
// gemini_cli/codex_cli only caught the sync throw, so registering them made
// `lazyclaw providers test` (which probes every provider in parallel) crash
// the whole process on any box without the `gemini`/`codex` binaries — CI
// went red the moment they joined the registry. claude_cli got this fix in
// F8; this pins the same behavior for all three.

import test from 'node:test';
import assert from 'node:assert/strict';
import { geminiCliProvider } from '../providers/gemini_cli.mjs';
import { codexCliProvider } from '../providers/codex_cli.mjs';
import { claudeCliProvider } from '../providers/claude_cli.mjs';

const MSGS = [{ role: 'user', content: 'ping' }];
const MISSING_BIN = 'definitely-not-a-real-binary-xyz-12345';

async function drain(provider) {
  let out = '';
  for await (const chunk of provider.sendMessage(MSGS, { bin: MISSING_BIN })) out += chunk;
  return out;
}

for (const [name, provider] of [
  ['gemini-cli', geminiCliProvider],
  ['codex-cli', codexCliProvider],
  ['claude-cli', claudeCliProvider],
]) {
  test(`${name}: missing binary -> catchable CLI_MISSING error, no process crash`, async () => {
    let err = null;
    try { await drain(provider); } catch (e) { err = e; }
    assert.ok(err, 'sendMessage rejected instead of crashing the process');
    assert.equal(err.code, 'CLI_MISSING', `got ${err.code}: ${err.message}`);
  });
}

test('all three missing-binary probes run in PARALLEL without killing the process', async () => {
  // Mirrors what `providers test` does — the original crash mode.
  const results = await Promise.allSettled([
    drain(geminiCliProvider), drain(codexCliProvider), drain(claudeCliProvider),
  ]);
  for (const r of results) {
    assert.equal(r.status, 'rejected');
    assert.equal(r.reason.code, 'CLI_MISSING');
  }
});
