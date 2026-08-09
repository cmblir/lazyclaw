import test from 'node:test';
import assert from 'node:assert/strict';
import { destructivePrompt } from '../daemon/lib/slash_destructive.mjs';

test('remove/delete/rm subcommands are recognised and name their target', () => {
  const p = destructivePrompt('/team', 'remove crew');
  assert.match(p, /crew/, 'the prompt must name what is about to be destroyed');
  assert.match(p, /remove|delete/i);
  assert.ok(destructivePrompt('/agent', 'remove dev'));
  assert.ok(destructivePrompt('/team', 'rm crew'), 'rm alias is gated');
  assert.ok(destructivePrompt('/agent', 'rm dev'), 'rm alias is gated');
  assert.ok(destructivePrompt('/task', 'rm t_123'), 'rm alias is gated');
  assert.ok(destructivePrompt('/task', 'abandon t_123'));
});

test('/skill clear and unset are gated (the real destructive path)', () => {
  const clear = destructivePrompt('/skill', 'clear');
  assert.ok(clear, '/skill clear must be gated');
  assert.match(clear, /system prompt/i);
  const unset = destructivePrompt('/skill', 'unset');
  assert.ok(unset, '/skill unset must be gated');
  assert.match(unset, /system prompt/i);
  // Case-insensitive
  assert.ok(destructivePrompt('/skill', 'CLEAR'));
  assert.ok(destructivePrompt('/skill', '  UNSET  '));
});

test('the reset family is destructive even with no arguments', () => {
  for (const cmd of ['/new', '/reset', '/clear']) {
    assert.ok(destructivePrompt(cmd, ''), `${cmd} discards the conversation`);
  }
});

test('read-only and additive commands are not gated', () => {
  for (const [cmd, args] of [
    ['/status', ''], ['/help', ''], ['/team', 'list'], ['/team', 'add crew'],
    ['/agent', 'list'], ['/skill', 'list'], ['/skill', 'refactor'], ['/model', ''], ['/config', 'get provider'],
  ]) {
    assert.equal(destructivePrompt(cmd, args), null, `${cmd} ${args} must not prompt`);
  }
});

test('a removal-looking word inside a value does not trigger the gate', () => {
  // The subcommand is the first token; anything later is data.
  assert.equal(destructivePrompt('/team', 'add remove-crew'), null);
  assert.equal(destructivePrompt('/config', 'set note "remove this later"'), null);
});

test('matching is case-insensitive and tolerant of extra whitespace', () => {
  assert.ok(destructivePrompt('/team', '  REMOVE   crew '));
});

test('an unknown command is never gated — dispatch reports it', () => {
  assert.equal(destructivePrompt('/nope', 'remove everything'), null);
});

test('/personality remove/rm/delete are gated and name the target', () => {
  const p = destructivePrompt('/personality', 'remove novelist');
  assert.ok(p, '/personality remove must be gated');
  assert.match(p, /novelist/, 'the prompt must name the personality');
  assert.match(p, /remove|delete/i);
  assert.ok(destructivePrompt('/personality', 'rm poet'), '/personality rm is gated');
  assert.ok(destructivePrompt('/personality', 'delete critic'), '/personality delete is gated');
  assert.equal(destructivePrompt('/personality', 'list'), null, '/personality list is not gated');
});

test('/workflow is not gated because it is not a slash command', () => {
  // /workflow is a CLI subcommand (commands/workflow.mjs), not in SLASH_HANDLERS.
  // A rule here would imply dashboard coverage that does not exist.
  assert.equal(destructivePrompt('/workflow', 'clear'), null);
  assert.equal(destructivePrompt('/workflow', 'stop'), null);
});
