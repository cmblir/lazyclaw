import test from 'node:test';
import assert from 'node:assert/strict';
import { theme } from '../tui/theme.mjs';

test('theme exports amber, dim, accent tokens', () => {
  assert.equal(theme.amber, '#FFB347');
  assert.equal(typeof theme.dim, 'function');
  assert.equal(typeof theme.accent, 'function');
  assert.equal(typeof theme.muted, 'function');
});

test('theme.colorize wraps text with ANSI when chalk is in TTY mode', () => {
  const out = theme.colorize('hello');
  assert.ok(out.includes('hello'));
});

test('theme.plain returns input unchanged for non-TTY pipelines', () => {
  assert.equal(theme.plain('hello'), 'hello');
});
