import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiArgs, geminiEnv } from '../providers/gemini_cli.mjs';

// The gemini trusted-folder bypass used to be hard-coded in TWO places — the
// --skip-trust flag AND the GEMINI_CLI_TRUST_WORKSPACE env — so dropping one
// silently left the other. Consolidated behind ONE switch (opts.trustWorkspace,
// default true) so the posture is auditable and disableable in one place.

test('gemini trustWorkspace default (true) applies both the flag and the env', () => {
  const args = geminiArgs('hello', {});
  assert.ok(args.includes('--skip-trust'));
  assert.deepEqual(args.slice(args.indexOf('-p')), ['-p', 'hello', '-o', 'json']);
  assert.equal(geminiEnv({}).GEMINI_CLI_TRUST_WORKSPACE, 'true');
});

test('gemini trustWorkspace:false drops BOTH bypasses (single switch)', () => {
  const args = geminiArgs('hi', { trustWorkspace: false });
  assert.ok(!args.includes('--skip-trust'));
  assert.deepEqual(args, ['-p', 'hi', '-o', 'json']);
  assert.equal(geminiEnv({ trustWorkspace: false }).GEMINI_CLI_TRUST_WORKSPACE, undefined);
});

test('gemini model + apiKey thread through args/env', () => {
  assert.deepEqual(geminiArgs('p', { model: 'gemini-2.0-flash' }).slice(-2), ['-m', 'gemini-2.0-flash']);
  assert.equal(geminiEnv({ apiKey: 'k' }).GEMINI_API_KEY, 'k');
});
