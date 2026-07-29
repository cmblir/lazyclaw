// tests/f-clear-splash-persist.test.mjs — /clear must leave the splash on
// screen, not a blank void.
//
// Mechanism under test: Ink's <Static> is write-once (it tracks how many items
// it has already emitted), so resetting React state back to [splash] does not
// re-print it. ReplApp keys the <Static> by state.generation; onConversationReset
// bumps that generation, which remounts <Static> and re-emits every item.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeReplState, onUserInput, onStreamChunk, onTurnComplete } from '../tui/repl_reducers.mjs';
import { onConversationReset } from '../tui/repl_reset.mjs';

const splashItem = { kind: 'splash', id: 'splash-0', splashProps: { provider: 'anthropic', model: 'm' } };

test('makeReplState starts at generation 0', () => {
  assert.equal(makeReplState().generation, 0);
  assert.equal(makeReplState({ splashItem }).generation, 0);
});

test('onConversationReset keeps the splash and bumps the generation', () => {
  let s = makeReplState({ splashItem });
  const ctrl = { abort: () => {} };
  s = onUserInput(s, { text: 'hi', controller: ctrl });
  s = onStreamChunk(s, { chunk: 'there' });
  s = onTurnComplete(s, { reason: 'done' });
  assert.ok(s.scrollback.length > 1);

  const cleared = onConversationReset(s);
  assert.equal(cleared.scrollback.length, 1);
  assert.equal(cleared.scrollback[0].kind, 'splash');
  assert.equal(cleared.generation, 1, 'generation must change so <Static> remounts');
  assert.equal(cleared.liveAssistant, '');
  assert.equal(cleared.streaming, false);
});

test('repeated resets keep bumping the generation', () => {
  let s = makeReplState({ splashItem });
  s = onConversationReset(s);
  s = onConversationReset(s);
  s = onConversationReset(s);
  assert.equal(s.generation, 3);
});

test('a reset with no splash item still bumps the generation', () => {
  const s = onConversationReset(makeReplState());
  assert.deepEqual(s.scrollback, []);
  assert.equal(s.generation, 1);
});
