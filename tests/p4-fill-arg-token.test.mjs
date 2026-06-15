// tests/p4-fill-arg-token.test.mjs — fillArgToken swaps the trailing arg token
// in place (used by slash-argument completion). Does not submit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEditorState, fillArgToken } from '../tui/editor_keys.mjs';

function buf(s) { return { ...makeEditorState({}), buffer: s, cursor: s.length }; }

test('fillArgToken replaces the partial token after the command', () => {
  const next = fillArgToken(buf('/model gpt'), 'gpt-4.1');
  assert.equal(next.buffer, '/model gpt-4.1');
  assert.equal(next.cursor, next.buffer.length);
  assert.equal(next.lastSubmit, null);
});

test('fillArgToken appends when the arg token is empty', () => {
  const next = fillArgToken(buf('/model '), 'claude-opus-4-8');
  assert.equal(next.buffer, '/model claude-opus-4-8');
});

test('fillArgToken replaces only the last token (multi-word args)', () => {
  const next = fillArgToken(buf('/trainer set anth'), 'anthropic:claude-opus-4-8');
  assert.equal(next.buffer, '/trainer set anthropic:claude-opus-4-8');
});
