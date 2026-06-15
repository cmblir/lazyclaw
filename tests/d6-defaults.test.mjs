// tests/d6-defaults.test.mjs — provider default + adapter-fallback models must
// point at a current model, not a previous-gen literal. Regression: claude-cli
// and anthropic defaultModel were claude-opus-4-7 while the streaming/tool_use
// fallbacks disagreed (and gemini's streaming fallback was gemini-1.5-pro).

import test from 'node:test';
import assert from 'node:assert/strict';
import * as registry from '../providers/registry.mjs';

test('claude-cli + anthropic default to the current Opus', () => {
  const info = registry.PROVIDER_INFO;
  assert.equal(info['claude-cli'].defaultModel, 'claude-opus-4-8');
  assert.equal(info['anthropic'].defaultModel, 'claude-opus-4-8');
  assert.ok(info['claude-cli'].suggestedModels.includes('claude-opus-4-8'));
  assert.ok(info['anthropic'].suggestedModels.includes('claude-opus-4-8'));
});

test('claude-fable-5 is not suggested (policy: not available on this tier)', () => {
  const info = registry.PROVIDER_INFO;
  assert.ok(!info['claude-cli'].suggestedModels.includes('claude-fable-5'));
  assert.ok(!info['anthropic'].suggestedModels.includes('claude-fable-5'));
});

test('gemini default is gemini-2.5-pro', () => {
  assert.equal(registry.PROVIDER_INFO['gemini'].defaultModel, 'gemini-2.5-pro');
});
