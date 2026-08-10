// tests/f-slash-actions.test.mjs — the panel button → slash line grammar.
//
// These are the exact lines a user would type. Pinning them here means a
// panel cannot quietly invent a variant the CLI does not accept. Every
// expected line was checked against the real handler in
// tui/slash_dispatcher.mjs / tui/slash_team.mjs / tui/slash_workflow.mjs /
// tui/config_picker.mjs, not assumed.
//
// Task 8 originally shipped without teamMemberAdd/Remove and
// workflowRun/Resume/Clear — no backing command existed. Task 14 added
// `/team member add|remove`, `/workflow run|resume|clear`, and
// `--provider`/`--model` on `/agent add`; those composers are pinned below
// against that grammar, verified end-to-end through dispatchSlash (not just
// string-matched) — see the git history around this file for the trace.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../web/ui/slash_actions.mjs';

test('agent lines', () => {
  // /agent add takes --provider/--model as optional flags (Task 14) plus
  // free trailing role text — tui/slash_dispatcher.mjs's _agent handler.
  assert.equal(A.agentCreate({ name: 'dev', role: 'backend' }), '/agent add dev backend');
  assert.equal(A.agentCreate({ name: 'dev' }), '/agent add dev');
  assert.equal(A.agentCreate({ name: 'dev', provider: 'anthropic', model: 'opus', role: 'backend' }),
    '/agent add dev --provider anthropic --model opus backend');
  assert.equal(A.agentCreate({ name: 'dev', provider: 'anthropic' }), '/agent add dev --provider anthropic');
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

test('team member lines', () => {
  // /team member add|remove <team> <agent> — tui/slash_team.mjs (Task 14).
  assert.equal(A.teamMemberAdd('crew', 'qa'), '/team member add crew qa');
  assert.equal(A.teamMemberRemove('crew', 'qa'), '/team member remove crew qa');
});

test('workflow lines', () => {
  // /workflow run|resume|clear <name> — tui/slash_workflow.mjs (Task 14).
  assert.equal(A.workflowRun('nightly'), '/workflow run nightly');
  assert.equal(A.workflowResume('nightly'), '/workflow resume nightly');
  assert.equal(A.workflowClear('nightly'), '/workflow clear nightly');
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
  // mangles the rest of the line instead. Throwing here is the honest
  // alternative.
  assert.throws(() => A.configSet('greeting', 'say "hi"'), /"/);
  assert.throws(() => A.taskIssue({ team: 'crew', title: 'say "hi" now' }), /"/);
});

// Fix round: a review found agentCreate's `role` was concatenated raw,
// bypassing arg() entirely — unlike every other free-text field. Verified
// against the committed code before this fix:
// agentCreate({name:'dev', role:'"hi" there'}) produced the STRING
// '/agent add dev "hi" there' with no error, which the real tokenizer
// (loop-engine.mjs's splitArgs) turns into ['add','dev','hi','there'] — the
// quote characters silently vanish and the saved role is wrong. That is
// worse than throwing: it looks like it worked. `role` must get the exact
// same throw-on-embedded-quote protection every other value gets.
test('agentCreate protects `role` the same way every other free-text value is protected', () => {
  assert.throws(() => A.agentCreate({ name: 'dev', role: '"hi" there' }), /"/);
  // The positive case must still round-trip a plain multi-word role exactly
  // (verified end-to-end through dispatchSlash during development; pinned
  // here at the composer level).
  assert.equal(A.agentCreate({ name: 'dev', role: 'senior backend engineer' }),
    '/agent add dev "senior backend engineer"');
});

// Fix round: teamCreate's `--agents` list was `agents.join(',')` — every
// other value in this file goes through arg(), this one did not. Names are
// slug-like in practice (low risk), but the guard should not depend on a
// reviewer noticing which call sites "look" risky.
test('teamCreate protects each --agents entry the same way, not just lead/channel', () => {
  assert.throws(() => A.teamCreate({ name: 'crew', agents: ['ok1', 'bad"2'] }), /"/);
});

test('a missing required name is a thrown programming error, not a malformed line', () => {
  // A blank name would compose '/team remove ' — which the confirm table
  // reads as a destructive command with no target.
  for (const fn of [
    () => A.agentRemove(''),
    () => A.teamRemove(null),
    () => A.taskAbandon(undefined),
    () => A.teamMemberAdd('crew', ''),
    () => A.teamMemberRemove('', 'qa'),
    () => A.workflowRun(''),
    () => A.workflowResume(null),
    () => A.workflowClear(undefined),
  ]) {
    assert.throws(fn, /required/);
  }
});
