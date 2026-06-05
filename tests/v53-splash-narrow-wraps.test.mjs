// v5.3 splash NARROW tier: verb lists wrap onto multiple rows rather than
// being truncated with '…'. The full verb list of every group must be
// present in the rendered output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSplashToString, SUBCOMMAND_GROUPS } from '../tui/splash.mjs';

const fixture = {
  version: '5.3.0',
  provider: 'claude-cli',
  model: 'claude-opus-4-7',
  trainer: { provider: 'claude-cli', model: 'claude-haiku-4-5' },
  sessionId: 'abc123',
  cwd: '/tmp/x',
  tools: [
    { category: 'fs', sensitive: false, verbs: ['read', 'write', 'edit', 'glob', 'grep'] },
    { category: 'exec', sensitive: false, verbs: ['bash', 'spawn', 'kill'] },
  ],
  skills: [
    { group: 'dev', names: ['review', 'debug', 'simplify'] },
  ],
};

test('NARROW tier at cols=80 emits the full verb list of every subcommand group (no truncation)', () => {
  const out = renderSplashToString(fixture, { columns: 80 });
  // The rendered output must not include any ellipsis truncation marker.
  assert.ok(!out.includes('…'), 'narrow tier must wrap, not truncate with ellipsis');

  // Every single subcommand verb must appear verbatim in the output. The
  // wrapVerbs() helper splits long groups across multiple rows, but every
  // verb stays present somewhere in the rendered text.
  for (const [, verbs] of SUBCOMMAND_GROUPS) {
    for (const verb of verbs) {
      assert.ok(out.includes(verb), `expected verb '${verb}' to appear at cols=80`);
    }
  }
});

test('NARROW tier at cols=80 emits every tool verb (no truncation)', () => {
  const out = renderSplashToString(fixture, { columns: 80 });
  for (const t of fixture.tools) {
    for (const v of t.verbs) {
      assert.ok(out.includes(v), `expected tool verb '${v}' (group ${t.category}) at cols=80`);
    }
  }
});
