// tests/f-slash-actions.test.mjs — the panel button → slash line grammar.
//
// These are the exact lines a user would type. Pinning them here means a
// panel cannot quietly invent a variant the CLI does not accept. Every
// expected line was checked against the real handler in
// tui/slash_dispatcher.mjs / tui/config_picker.mjs, not assumed — see
// web/ui/slash_actions.mjs's header for the composers dropped because no
// real command backs them (team member add, workflow run/resume).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../web/ui/slash_actions.mjs';

test('agent lines', () => {
  // /agent add takes the role as free trailing text — tui/slash_dispatcher.mjs's
  // _agent handler has no --role/--model flag.
  assert.equal(A.agentCreate({ name: 'dev', role: 'backend' }), '/agent add dev backend');
  assert.equal(A.agentCreate({ name: 'dev' }), '/agent add dev');
  assert.equal(A.agentRemove('dev'), '/agent remove dev');
});

test('team lines', () => {
  assert.equal(A.teamCreate({ name: 'crew', agents: ['dev', 'qa'], lead: 'dev' }),
    '/team add crew --agents dev,qa --lead dev');
  assert.equal(A.teamCreate({ name: 'crew' }), '/team add crew');
  assert.equal(A.teamCreate({ name: 'crew', agents: ['dev'], channel: '#ops' }),
    '/team add crew --agents dev --channel #ops');
  assert.equal(A.teamRemove('crew'), '/team remove crew');
});

test('task and config lines', () => {
  // Positional title (the original draft) is silently dropped by
  // tui/slash_dispatcher.mjs's `/task start` handler — --title is required.
  assert.equal(A.taskIssue({ team: 'crew', title: 'ship the thing' }),
    '/task start crew --title "ship the thing"');
  assert.equal(A.taskAbandon('t_1'), '/task abandon t_1');
  assert.equal(A.taskDone('t_1'), '/task done t_1');
  assert.equal(A.configSet('provider', 'claude-cli'), '/config set provider claude-cli');
  assert.equal(A.configUnset('provider'), '/config unset provider');
});

test('values containing spaces are quoted so the tokenizer keeps them as one argument', () => {
  assert.equal(A.configSet('greeting', 'hello world'), '/config set greeting "hello world"');
  assert.equal(A.taskIssue({ team: 'crew', title: 'say hi now' }), '/task start crew --title "say hi now"');
});

test('a literal double quote cannot be represented on this grammar — refuse rather than corrupt the line', () => {
  // loop-engine.mjs's splitArgs (the dispatcher's real tokenizer) has no
  // escape for `"` — it only toggles quote state — so a backslash-escaped
  // quote (the original draft's approach) does not round-trip; it silently
  // mangles the rest of the line instead. Verified against splitArgs
  // directly: '"say \"hi\" now"' tokenizes to `say \hi\ now`, not the
  // intended text. Throwing here is the honest alternative.
  assert.throws(() => A.configSet('greeting', 'say "hi"'), /"/);
  assert.throws(() => A.taskIssue({ team: 'crew', title: 'say "hi" now' }), /"/);
});

test('a missing required name is a thrown programming error, not a malformed line', () => {
  // A blank name would compose '/team remove ' — which the confirm table
  // reads as a destructive command with no target.
  for (const fn of [() => A.agentRemove(''), () => A.teamRemove(null), () => A.taskAbandon(undefined)]) {
    assert.throws(fn, /required/);
  }
});
