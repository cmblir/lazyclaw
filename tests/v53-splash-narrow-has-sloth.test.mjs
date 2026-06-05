// v5.3 splash NARROW tier: the sloth banner is rendered (stacked above
// the panel) rather than dropped, as it was in the pre-v5.3 layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSplashToString } from '../tui/splash.mjs';
import { banner } from '../tui/banner.generated.mjs';

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

test('NARROW tier at cols=80 includes the sloth banner (first row of banner present)', () => {
  const out = renderSplashToString(fixture, { columns: 80 });
  // The first row of the banner must appear verbatim somewhere in the output.
  assert.ok(out.includes(banner.rows[0]),
    `expected first sloth row to appear at cols=80\nfirst row: ${banner.rows[0]}`);
});

test('NARROW tier at cols=80 includes every row of the sloth banner', () => {
  const out = renderSplashToString(fixture, { columns: 80 });
  for (const [i, row] of banner.rows.entries()) {
    assert.ok(out.includes(row), `expected sloth row ${i} at cols=80`);
  }
});
