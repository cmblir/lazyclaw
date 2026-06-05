// v5.3 splash NARROW tier: a bordered panel surrounds the subcommand /
// tools / skills section, rather than the bare single-column layout used
// before. Verify the top ('╭') and bottom ('╰') panel corners are present.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSplashToString } from '../tui/splash.mjs';

const fixture = {
  version: '5.3.0',
  provider: 'claude-cli',
  model: 'claude-opus-4-7',
  trainer: { provider: 'claude-cli', model: 'claude-haiku-4-5' },
  sessionId: 'abc123',
  cwd: '/tmp/x',
  tools: [
    { category: 'fs', sensitive: false, verbs: ['read', 'write'] },
  ],
  skills: [],
};

test('NARROW tier at cols=80 renders a bordered panel (contains ╭ and ╰)', () => {
  const out = renderSplashToString(fixture, { columns: 80 });
  assert.ok(out.includes('╭'), 'expected top panel corner ╭ at cols=80');
  assert.ok(out.includes('╰'), 'expected bottom panel corner ╰ at cols=80');
});

test('NARROW tier at cols=60 renders a bordered panel (contains ╭ and ╰)', () => {
  const out = renderSplashToString(fixture, { columns: 60 });
  assert.ok(out.includes('╭'), 'expected top panel corner ╭ at cols=60');
  assert.ok(out.includes('╰'), 'expected bottom panel corner ╰ at cols=60');
});
