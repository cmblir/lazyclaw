// Phase A: trainer provider resolution (spec §2.3, §2.4, canonical C9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTrainer, parseProviderModel } from '../providers/registry.mjs';

test('resolveTrainer: omitted trainer mirrors chat provider (v4 compat)', () => {
  const got = resolveTrainer({ provider: 'claude-cli', model: 'claude-opus-4-7' });
  assert.equal(got.provider, 'claude-cli');
  assert.equal(got.model, 'claude-opus-4-7');
});

test('resolveTrainer: explicit trainer overrides chat (canonical kebab-case C3)', () => {
  const got = resolveTrainer({
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    trainer: { provider: 'openai', model: 'gpt-4o-mini' },
  });
  assert.equal(got.provider, 'openai');
  assert.equal(got.model, 'gpt-4o-mini');
});

test('resolveTrainer: trainer.model omitted inherits chat model', () => {
  const got = resolveTrainer({
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    trainer: { provider: 'claude-cli' },
  });
  assert.equal(got.provider, 'claude-cli');
  assert.equal(got.model, 'claude-opus-4-7');
});

test('resolveTrainer: "auto" with no Pro/Max detection mirrors chat provider (C9)', () => {
  const got = resolveTrainer(
    { provider: 'anthropic', model: 'claude-opus-4-7', trainer: { provider: 'auto' } },
    { detectClaudeCli: () => false },
  );
  assert.equal(got.provider, 'anthropic');
  assert.equal(got.model, 'claude-opus-4-7');
});

test('resolveTrainer: "auto" with Pro/Max detection resolves to claude-cli (C9)', () => {
  const got = resolveTrainer(
    { provider: 'anthropic', model: 'claude-opus-4-7', trainer: { provider: 'auto' } },
    { detectClaudeCli: () => true },
  );
  assert.equal(got.provider, 'claude-cli');
});

test('resolveTrainer: useFallback parses provider:model fallback string', () => {
  const got = resolveTrainer(
    { provider: 'anthropic', model: 'claude-opus-4-7',
      trainer: { provider: 'claude-cli', fallback: 'openai:gpt-4o-mini' } },
    { useFallback: true },
  );
  assert.equal(got.provider, 'openai');
  assert.equal(got.model, 'gpt-4o-mini');
});

test('parseProviderModel: splits on first colon', () => {
  assert.deepEqual(parseProviderModel('openai:gpt-4o-mini'),
    { provider: 'openai', model: 'gpt-4o-mini' });
  assert.deepEqual(parseProviderModel('anthropic:claude-opus-4-7:beta'),
    { provider: 'anthropic', model: 'claude-opus-4-7:beta' });
  assert.deepEqual(parseProviderModel('claude-cli'),
    { provider: 'claude-cli', model: null });
});
