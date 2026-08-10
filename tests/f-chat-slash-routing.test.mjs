// tests/f-chat-slash-routing.test.mjs — web/ui/panels/chat.mjs's two pure
// routing/autocomplete rules, exercised with no DOM (see task-9-brief.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSlashLine, filterCommands } from '../web/ui/panels/chat.mjs';

test('only a leading slash routes to the dispatcher', () => {
  assert.equal(isSlashLine('/status'), true);
  assert.equal(isSlashLine('  /status'), true, 'leading whitespace is trimmed');
  assert.equal(isSlashLine('what is /status?'), false, 'a slash mid-sentence is prose');
  assert.equal(isSlashLine('http://x/y'), false);
  assert.equal(isSlashLine(''), false);
  assert.equal(isSlashLine('/'), false, 'a bare slash is not a command yet');
});

test('autocomplete filters by prefix and keeps registry order', () => {
  const all = [
    { name: '/status', description: 'show status' },
    { name: '/skill', description: 'skills' },
    { name: '/team', description: 'teams' },
  ];
  assert.deepEqual(filterCommands(all, '/s').map((c) => c.name), ['/status', '/skill']);
  assert.deepEqual(filterCommands(all, '/te').map((c) => c.name), ['/team']);
  assert.deepEqual(filterCommands(all, '/').map((c) => c.name), ['/status', '/skill', '/team']);
  assert.deepEqual(filterCommands(all, '/zz'), []);
});

test('filtering is case-insensitive and ignores a trailing argument', () => {
  const all = [{ name: '/team', description: 'teams' }];
  assert.deepEqual(filterCommands(all, '/TE').map((c) => c.name), ['/team']);
  assert.deepEqual(filterCommands(all, '/team add crew'), [],
    'once an argument is typed the popover closes');
});
