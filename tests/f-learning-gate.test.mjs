import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _shouldLearn } from '../tui/run_turn.mjs';

// The post-task learning hook spawns TWO extra `claude` processes (skill synth +
// user-model) on EVERY chat turn. A greeting or one-liner is not worth a durable
// SKILL.md or a user-model dialectic, and firing every turn triples the per-
// message claude spawn count + competes with the user's next turn for quota.

test('skips trivial turns (greetings / acks / very short)', () => {
  assert.equal(_shouldLearn([{ role: 'user', content: 'thanks' }, { role: 'assistant', content: 'You are welcome.' }]), false);
  assert.equal(_shouldLearn([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello! How can I help?' }]), false);
  assert.equal(_shouldLearn([{ role: 'user', content: 'ok' }, { role: 'assistant', content: 'Done.' }]), false);
});

test('runs learning on a substantive turn', () => {
  const long = 'Explain exactly how the sandbox confiner chooses seatbelt vs bubblewrap, '
    + 'why the deny-default profile broke python3 on macOS, and what the robust profile does instead. ';
  const reply = 'The confiner is picked by platform: '.repeat(8);
  assert.equal(_shouldLearn([{ role: 'user', content: long }, { role: 'assistant', content: reply }]), true);
});

test('skips when the assistant reply is empty (aborted/failed turn)', () => {
  assert.equal(_shouldLearn([{ role: 'user', content: 'a real substantive question '.repeat(20) }, { role: 'assistant', content: '' }]), false);
});
