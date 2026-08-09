import test from 'node:test';
import assert from 'node:assert/strict';
import { destructivePrompt } from '../daemon/lib/slash_destructive.mjs';

test('remove/delete subcommands are recognised and name their target', () => {
  const p = destructivePrompt('/team', 'remove crew');
  assert.match(p, /crew/, 'the prompt must name what is about to be destroyed');
  assert.match(p, /remove|delete/i);
  assert.ok(destructivePrompt('/agent', 'remove dev'));
  assert.ok(destructivePrompt('/skill', 'remove note-taker'));
  assert.ok(destructivePrompt('/task', 'abandon t_123'));
});

test('the reset family is destructive even with no arguments', () => {
  for (const cmd of ['/new', '/reset', '/clear']) {
    assert.ok(destructivePrompt(cmd, ''), `${cmd} discards the conversation`);
  }
});

test('read-only and additive commands are not gated', () => {
  for (const [cmd, args] of [
    ['/status', ''], ['/help', ''], ['/team', 'list'], ['/team', 'add crew'],
    ['/agent', 'list'], ['/skill', 'list'], ['/model', ''], ['/config', 'get provider'],
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
