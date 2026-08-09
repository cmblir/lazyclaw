// tests/f-confirm-tokens.test.mjs
// A confirm token is the only thing standing between a dashboard click and a
// destructive slash command. It must be single-use (a replayed token cannot
// re-run the delete), bound to its line (a token minted for a harmless
// command cannot authorise a dangerous one), and short-lived.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfirmStore } from '../daemon/lib/confirm_tokens.mjs';

test('a freshly issued token redeems exactly once', () => {
  const s = makeConfirmStore();
  const t = s.issue('/team remove crew');
  assert.equal(s.redeem(t, '/team remove crew'), true);
  assert.equal(s.redeem(t, '/team remove crew'), false, 'a replayed token must not work twice');
});

test('a token is bound to the line it was issued for', () => {
  const s = makeConfirmStore();
  const t = s.issue('/skill remove note-taker');
  assert.equal(s.redeem(t, '/team remove crew'), false,
    'a token minted for one command must not authorise another');
  assert.equal(s.redeem(t, '/skill remove note-taker'), true, 'the original line still works');
});

test('a token expires after its TTL', () => {
  let clock = 1000;
  const s = makeConfirmStore({ ttlMs: 60000, now: () => clock });
  const t = s.issue('/team remove crew');
  clock += 59999;
  assert.equal(s.redeem(t, '/team remove crew'), true, 'still valid just inside the window');

  const t2 = s.issue('/team remove crew');
  clock += 60001;
  assert.equal(s.redeem(t2, '/team remove crew'), false, 'expired');
});

test('unknown and malformed tokens are refused, not thrown on', () => {
  const s = makeConfirmStore();
  for (const bad of ['', null, undefined, 'c_nope', 42, {}]) {
    assert.equal(s.redeem(bad, '/team remove crew'), false, `${JSON.stringify(bad)} must be refused`);
  }
});

test('redeeming and expiring both release storage', () => {
  let clock = 1000;
  const s = makeConfirmStore({ ttlMs: 1000, now: () => clock });
  const t = s.issue('/a');
  s.issue('/b');
  assert.equal(s.size(), 2);
  s.redeem(t, '/a');
  assert.equal(s.size(), 1, 'a redeemed token is deleted');
  clock += 1001;
  s.issue('/c');            // any write sweeps expired entries
  assert.equal(s.size(), 1, 'the expired /b entry is swept, leaving only /c');
});

test('two issues for the same line produce distinct tokens', () => {
  const s = makeConfirmStore();
  assert.notEqual(s.issue('/team remove crew'), s.issue('/team remove crew'));
});
