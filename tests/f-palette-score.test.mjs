// tests/f-palette-score.test.mjs — the ranking is what makes the palette feel
// right, so it is a pure function with tests rather than a feel.
//
// palette.mjs imports `open` from shell.mjs, which imports motion.mjs, which
// reads matchMedia at module load time (not just inside a function) — same
// no-jsdom stubbing style as f-shell-cleanup-resolve.test.mjs and
// f-dashboard-dom.test.mjs: stub the one global before the dynamic import.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.matchMedia = globalThis.matchMedia || (() => ({ matches: false }));
const { score } = await import('../web/ui/palette.mjs');

const item = { label: 'Team Live', kind: 'panel', hint: 'agents' };

test('an empty needle keeps everything at a neutral score', () => {
  assert.equal(score(item, ''), 0);
});

test('an earlier substring match scores higher', () => {
  assert.ok(score({ label: 'Tasks', kind: 'panel', hint: '' }, 'tas')
          > score({ label: 'Sandbox tasks', kind: 'panel', hint: '' }, 'tas'));
});

test('a subsequence still matches, below any substring hit', () => {
  const sub = score(item, 'tmlv');
  assert.ok(sub > 0, 'tmlv should find Team Live');
  assert.ok(sub < score(item, 'team'), 'a real substring must rank above a subsequence');
});

test('no match at all scores negative so it can be filtered out', () => {
  assert.ok(score(item, 'zzzz') < 0);
});

test('kind and hint are searchable, not just the label', () => {
  assert.ok(score(item, 'agents') > 0, 'hint is part of the haystack');
  assert.ok(score(item, 'panel') > 0, 'so is kind');
});
