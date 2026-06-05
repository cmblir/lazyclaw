import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSplashToString } from '../tui/splash.mjs';
import stringWidth from 'string-width';

const fixture = {
  provider: 'claude-cli',
  model: 'sonnet-4.7',
  trainer: { provider: 'claude-cli', model: 'haiku-4.5' },
  sessionId: '7af9abcd',
  cwd: '/Users/o/code/lazyclaw',
  tools: [
    { category: 'fs', sensitive: false, verbs: ['read','write','edit','glob','grep'] },
    { category: 'exec', sensitive: false, verbs: ['bash','spawn','kill'] },
    { category: 'admin', sensitive: true, verbs: ['keys','billing'] },
  ],
  skills: [
    { group: 'dev', names: ['review','debug','simplify'] },
    { group: 'docs', names: ['init','changelog','readme'] },
  ],
};

test('splash renders without throwing', () => {
  const out = renderSplashToString(fixture, { columns: 80 });
  assert.ok(typeof out === 'string' && out.length > 0);
});

test('every rendered line fits within 80 columns', () => {
  const out = renderSplashToString(fixture, { columns: 80 });
  for (const [i, line] of out.split('\n').entries()) {
    assert.ok(stringWidth(line) <= 80, `line ${i} width=${stringWidth(line)}`);
  }
});

test('footer is exactly 4 informational lines', () => {
  const out = renderSplashToString(fixture, { columns: 80 });
  assert.match(out, /provider · claude-cli · sonnet-4\.7/);
  assert.match(out, /trainer\s+· claude-cli · haiku-4\.5/);
  assert.match(out, /slash\s+· \/help/);
  assert.match(out, /hint\s+· Shift\+Enter/);
});

test('tools section lists verbs joined by middle-dot', () => {
  const out = renderSplashToString(fixture, { columns: 80 });
  assert.match(out, /fs\s+read · write · edit · glob · grep/);
});

test('sensitive tools are tagged with (sensitive)', () => {
  const out = renderSplashToString(fixture, { columns: 80 });
  assert.match(out, /\(sensitive\) admin/);
});
