// tests/f-chat-model-options.test.mjs — web/ui/panels/chat.mjs's
// buildModelOptions(provider), the pure option-shaping function behind the
// chat picker.
//
// Regression pin: the picker used to slice(0, 6) after GET /providers's
// suggestedModels went from a short curated list to a live-fetched one.
// Combined with fetchAnthropicModels's ascending alphabetical sort, that cap
// showed claude-cli's oldest dated snapshots and silently discarded
// claude-opus-4-8 (the provider's own defaultModel), claude-opus-5, and
// claude-sonnet-5 — i.e. exactly the models the fix was supposed to surface.
// A test asserting only "some options exist" would have passed against that
// broken code; every test here asserts the SPECIFIC ids are present.
//
// No DOM: this module has no top-level `document` access, so importing it
// for this pure function needs no browser stub.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModelOptions } from '../web/ui/panels/chat.mjs';

// The real claude-cli entry as GET /providers reports it once modelsSource
// is 'live' (11 models from providers/models.generated.mjs, defaultModel
// from the static registry) — alphabetically sorted, exactly as
// fetchAnthropicModels returns it.
const CLAUDE_CLI = {
  name: 'claude-cli',
  defaultModel: 'claude-opus-4-8',
  suggestedModels: [
    'claude-fable-5',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-1-20250805',
    'claude-opus-4-5-20251101',
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-sonnet-4-5-20250929',
    'claude-sonnet-4-6',
    'claude-sonnet-5',
  ],
};

test('buildModelOptions: no cap — every model is present, not just the first N', () => {
  const options = buildModelOptions(CLAUDE_CLI);
  assert.equal(options.length, 11);
  const values = options.map((o) => o.value);
  for (const m of CLAUDE_CLI.suggestedModels) {
    assert.ok(values.includes(`claude-cli:${m}`), `missing model: ${m}`);
  }
});

test('buildModelOptions: claude-opus-5 and claude-sonnet-5 are reachable (the reported regression)', () => {
  const options = buildModelOptions(CLAUDE_CLI);
  const values = options.map((o) => o.value);
  assert.ok(values.includes('claude-cli:claude-opus-5'));
  assert.ok(values.includes('claude-cli:claude-sonnet-5'));
});

test('buildModelOptions: the provider\'s own defaultModel is pinned first and labelled', () => {
  const options = buildModelOptions(CLAUDE_CLI);
  assert.equal(options[0].value, 'claude-cli:claude-opus-4-8');
  assert.equal(options[0].isDefault, true);
  assert.match(options[0].label, /\(default\)/);
  // exactly one option is marked default
  assert.equal(options.filter((o) => o.isDefault).length, 1);
});

test('buildModelOptions: with no defaultModel, original order is kept untouched (no guessed resort)', () => {
  const options = buildModelOptions({ name: 'codex-cli', defaultModel: null, suggestedModels: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5'] });
  assert.deepEqual(options.map((o) => o.value), ['codex-cli:gpt-5.6-sol', 'codex-cli:gpt-5.6-terra', 'codex-cli:gpt-5.5']);
  assert.ok(options.every((o) => o.isDefault === false));
});

test('buildModelOptions: a defaultModel absent from suggestedModels is not invented into the list', () => {
  const options = buildModelOptions({ name: 'p', defaultModel: 'not-in-list', suggestedModels: ['a', 'b'] });
  assert.deepEqual(options.map((o) => o.value), ['p:a', 'p:b']);
  assert.ok(options.every((o) => o.isDefault === false));
});

test('buildModelOptions: empty suggestedModels -> no options (caller falls back to a bare provider option)', () => {
  assert.deepEqual(buildModelOptions({ name: 'gemini-cli', defaultModel: null, suggestedModels: [] }), []);
});
