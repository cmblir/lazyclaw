import test from 'node:test';
import assert from 'node:assert/strict';
import { computeGhost, cycleGhost, acceptGhost } from '../tui/ghost.mjs';

const cmds = ['/help', '/model', '/trainer', '/skills', '/tools', '/exit'];

test('computeGhost returns dim suffix for prefix match', () => {
  const g = computeGhost('/he', cmds);
  assert.equal(g.suggestion, '/help');
  assert.equal(g.suffix, 'lp');
});

test('computeGhost returns null when no match', () => {
  const g = computeGhost('/zzz', cmds);
  assert.equal(g, null);
});

test('cycleGhost advances through multiple matches', () => {
  const g1 = computeGhost('/', cmds);
  const g2 = cycleGhost(g1, cmds);
  assert.notEqual(g1.suggestion, g2.suggestion);
});

test('acceptGhost returns the full completed buffer', () => {
  const g = computeGhost('/he', cmds);
  assert.equal(acceptGhost('/he', g), '/help');
});
