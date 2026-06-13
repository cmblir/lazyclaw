// tests/f-claude-cli-alias.test.mjs — FIX A2-claude-cli-model-drop.
//
// claude-cli silently drops the registry's own top-suggested models.
// PROVIDER_INFO['claude-cli'].suggestedModels leads with 'claude-fable-5'
// and 'claude-opus-4-8', but _CLI_MODEL_ALIASES did not map those ids, so
// resolveModelAlias() returned '' (= the CLI's default model), silently
// ignoring the user's explicit pick. These tests pin the mapping for the
// current canonical ids and guard against regressing the existing rows.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelAlias } from '../providers/claude_cli.mjs';

test('maps current canonical ids to short CLI forms', () => {
  assert.equal(resolveModelAlias('claude-opus-4-8'), 'opus');
  assert.equal(resolveModelAlias('claude-fable-5'), 'fable');
  assert.equal(resolveModelAlias('fable'), 'fable');
});

test('does not regress existing aliases', () => {
  assert.equal(resolveModelAlias('claude-opus-4-7'), 'opus');
  assert.equal(resolveModelAlias('opus'), 'opus');
});
