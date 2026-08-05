// tests/f-dashboard-motion.test.mjs — the reduced-motion gate is an
// accessibility guarantee, so assert it rather than trusting the CSS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const CSS = fs.readFileSync(path.join(import.meta.dirname, '..', 'web', 'dashboard.css'), 'utf8');

test('motion tokens are the agreed level-3 values', () => {
  for (const [k, v] of [['--dur-fast', '160ms'], ['--dur-mid', '260ms'], ['--dur-slow', '460ms'],
                        ['--stagger', '46ms'], ['--lift', '8px'], ['--ambient', '1']]) {
    assert.match(CSS, new RegExp(k.replace(/-/g, '\\-') + ':\\s*' + v), `${k} must be ${v}`);
  }
});

test('prefers-reduced-motion zeroes every motion token and kills animations', () => {
  const block = CSS.slice(CSS.indexOf('prefers-reduced-motion'));
  assert.ok(block, 'no reduced-motion block');
  for (const k of ['--dur-fast', '--dur-mid', '--dur-slow']) {
    assert.match(block, new RegExp(k.replace(/-/g, '\\-') + ':\\s*1ms'), `${k} must drop to 1ms`);
  }
  assert.match(block, /--stagger:\s*0/);
  assert.match(block, /--ambient:\s*0/);
});

test('the reduced-motion kill switch also selects generated content', () => {
  // `*` alone does not match ::before/::after — CSS's universal selector
  // excludes generated content — so `* { animation: none !important; }`
  // silently misses any animation declared on a pseudo-element. That let
  // the live-rail sweep (.liverail::before) and the streaming caret
  // (#stream-text::after) keep animating under reduced motion even after
  // every duration token was correctly zeroed. Assert the SELECTOR, not
  // just the declaration, or a regression that narrows this back to `*`
  // stays green.
  // Strip /* ... */ comments first — this file explains the ::before/::after
  // gotcha in prose right above the rule, and without stripping, that prose
  // itself contains "::before"/"::after" and makes the assertion below pass
  // no matter what the real selector says.
  const block = CSS.slice(CSS.indexOf('prefers-reduced-motion')).replace(/\/\*[\s\S]*?\*\//g, '');
  const decl = /animation:\s*none\s*!important/.exec(block);
  assert.ok(decl, 'no rule sets animation: none !important');
  const openBrace = block.lastIndexOf('{', decl.index);
  assert.notEqual(openBrace, -1, 'animation: none !important is not inside any rule');
  const priorClose = block.lastIndexOf('}', openBrace - 1);
  const selector = block.slice(priorClose + 1, openBrace).trim();
  assert.match(selector, /::before/, 'the kill switch must also select ::before');
  assert.match(selector, /::after/, 'the kill switch must also select ::after');
});

test('ambient motion is confined to the live rail', () => {
  const ambientUsers = [...CSS.matchAll(/var\(--ambient\)/g)];
  assert.equal(ambientUsers.length, 1, 'exactly one rule may read --ambient (the live rail sweep)');
  const idx = CSS.indexOf('var(--ambient)');
  assert.ok(CSS.lastIndexOf('.liverail', idx) > CSS.lastIndexOf('}', CSS.lastIndexOf('.liverail', idx) - 1) - 1,
    '--ambient must be read inside a .liverail rule');
});

test('the edge stroke is not --border (invisible against the panel)', () => {
  const edge = /#edges path\.edge\s*\{[^}]*\}/.exec(CSS);
  assert.ok(edge, 'no #edges path.edge rule');
  assert.doesNotMatch(edge[0], /stroke:\s*var\(--border\)/,
    'the reporting line is structure, not a gridline: --border disappears on --panel');
});

test('the absolutely-positioned edge svg is given a size', () => {
  const svg = /#edges\s*\{[^}]*\}/.exec(CSS);
  assert.ok(svg, 'no #edges rule');
  assert.match(svg[0], /width:\s*100%/, 'inset:0 alone leaves an <svg> at its intrinsic 300x150');
  assert.match(svg[0], /height:\s*100%/);
});
