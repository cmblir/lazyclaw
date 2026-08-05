// tests/f-providers-panel-model-summary.test.mjs —
// web/ui/panels/providers.mjs's formatModelsSummary(suggestedModels).
//
// Truncating a live-fetched provider's model list to six for the card view
// is fine (a table cell can't hold openrouter's 338 ids); presenting six as
// though it were the whole list is not — the same class of bug the chat
// picker's old slice(0, 6) had, just quieter. This pins that the summary
// says "(N of M)" whenever it's actually a truncation.
//
// No DOM: pure string formatting, no top-level `document` access in the module.

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatModelsSummary } from '../web/ui/panels/providers.mjs';

test('formatModelsSummary: short list (<=6) is shown whole, no "(N of M)" suffix', () => {
  assert.equal(formatModelsSummary(['a', 'b', 'c']), 'a · b · c');
  assert.equal(formatModelsSummary(['a', 'b', 'c', 'd', 'e', 'f']), 'a · b · c · d · e · f');
});

test('formatModelsSummary: a truncated list says how many of how many', () => {
  const models = Array.from({ length: 338 }, (_, i) => `m${i}`);
  const summary = formatModelsSummary(models);
  const expectedPrefix = models.slice(0, 6).join(' · ');
  assert.ok(summary.startsWith(expectedPrefix), `expected the first six ids verbatim, got: ${summary}`);
  assert.match(summary, /\(6 of 338\)$/, `expected a "(6 of 338)" suffix, got: ${summary}`);
});

test('formatModelsSummary: empty/missing list -> null (caller shows its own "(default)" fallback)', () => {
  assert.equal(formatModelsSummary([]), null);
  assert.equal(formatModelsSummary(undefined), null);
});
