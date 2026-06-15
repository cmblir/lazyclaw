// tests/p4-slash-args.test.mjs — argSpecFor resolves which command argument is
// completable from the catalog `arg` data (pure), including subcommand gating.

import test from 'node:test';
import assert from 'node:assert/strict';
import { argSpecFor, runArgCompleter } from '../tui/slash_args.mjs';
import { SLASH_COMMANDS } from '../tui/slash_commands.mjs';

test('argSpecFor matches /model arg position', () => {
  const s = argSpecFor('/model gpt', SLASH_COMMANDS);
  assert.equal(s.completer, 'model');
  assert.equal(s.partial, 'gpt');
});

test('argSpecFor matches /provider', () => {
  assert.equal(argSpecFor('/provider open', SLASH_COMMANDS).completer, 'provider');
});

test('argSpecFor requires the subcommand for /trainer', () => {
  assert.equal(argSpecFor('/trainer sh', SLASH_COMMANDS), null); // typing the subcommand, not the spec
  const s = argSpecFor('/trainer set anth', SLASH_COMMANDS);
  assert.equal(s.completer, 'trainerSpec');
  assert.equal(s.partial, 'anth');
});

test('argSpecFor gates /orchestrator + /agent on their subcommands', () => {
  assert.equal(argSpecFor('/orchestrator planner ', SLASH_COMMANDS).completer, 'orchestratorSpec');
  assert.equal(argSpecFor('/orchestrator status', SLASH_COMMANDS), null);
  assert.equal(argSpecFor('/agent edit sc', SLASH_COMMANDS).completer, 'agentName');
  assert.equal(argSpecFor('/agent add sc', SLASH_COMMANDS), null); // add takes a free-text name
});

test('argSpecFor returns null for a command with no arg spec / no space', () => {
  assert.equal(argSpecFor('/help foo', SLASH_COMMANDS), null);
  assert.equal(argSpecFor('/model', SLASH_COMMANDS), null);
});

test('runArgCompleter drives the model completer via a scripted picker', async () => {
  const ctx = {
    getActiveProvName: () => 'anthropic', getActiveModel: () => '',
    resolveAuthKey: () => '', cfg: {},
    openPicker: async () => 'claude-opus-4-8',
  };
  const registry = await import('../providers/registry.mjs');
  const spec = argSpecFor('/model claude', SLASH_COMMANDS);
  assert.equal(await runArgCompleter(spec, ctx, registry), 'claude-opus-4-8');
});
