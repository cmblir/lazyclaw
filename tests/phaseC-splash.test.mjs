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

test('every rendered line fits within 110 columns (Hermes-style hero width)', () => {
  const out = renderSplashToString(fixture, { columns: 110 });
  for (const [i, line] of out.split('\n').entries()) {
    assert.ok(stringWidth(line) <= 110, `line ${i} width=${stringWidth(line)}`);
  }
});

test('shows chat + trainer provider/model line', () => {
  const out = renderSplashToString(fixture, { columns: 120 });
  assert.match(out, /claude-cli · sonnet-4\.7/);
  assert.match(out, /trainer claude-cli · haiku-4\.5/);
});

test('shows welcome + tip lines', () => {
  const out = renderSplashToString(fixture, { columns: 120 });
  assert.match(out, /Welcome to lazyclaw/);
  assert.match(out, /Type your message or \/help for commands/);
});

test('tools section lists verbs joined by middle-dot', () => {
  const out = renderSplashToString(fixture, { columns: 120 });
  assert.match(out, /fs\s+read · write · edit · glob · grep/);
});

test('sensitive tools are flagged with *', () => {
  const out = renderSplashToString(fixture, { columns: 120 });
  assert.match(out, /admin\*\s+keys · billing/);
});
