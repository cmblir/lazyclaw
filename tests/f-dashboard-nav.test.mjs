// tests/f-dashboard-nav.test.mjs — the panel registry is the contract between
// the sidebar, the hash router, and the command palette. Pin its shape and the
// invariant that every id is unique and hash-safe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUPS, ALL } from '../web/ui/nav_model.mjs';

test('every panel lives in exactly one group and has a unique id', () => {
  const ids = ALL.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate panel id');
  assert.equal(ALL.length, GROUPS.reduce((n, g) => n + g.items.length, 0));
});

test('the 19 panels the dashboard already had are all still present', () => {
  const before = ['chat', 'sessions', 'workflows', 'skills', 'providers', 'rates',
    'metrics', 'doctor', 'config', 'status', 'agents', 'teams', 'tasks', 'team',
    'trainer', 'recall', 'sandbox', 'channels', 'scheduling'];
  for (const id of before) {
    assert.ok(ALL.some((x) => x.id === id), `panel ${id} went missing — its #hash deep-link would break`);
  }
});

test('the two gateway panels were added', () => {
  assert.ok(ALL.some((x) => x.id === 'approvals'));
  assert.ok(ALL.some((x) => x.id === 'gateway'));
  assert.equal(ALL.length, 21);
});

test('ids are safe to use as a URL hash', () => {
  for (const { id } of ALL) assert.match(id, /^[a-z][a-z0-9-]*$/, `${id} is not hash-safe`);
});
