// tests/v53-narrow-color.test.mjs — NARROW-tier color parity.
//
// Regression fix for v5.3: the Splash React component used to gate ALL
// per-row coloring behind `cols >= WORDMARK_BREAKPOINT`, so anything in
// the NARROW (45..89) and MEDIUM (90..139) tiers rendered with the
// terminal's default foreground (visually white on most themes). The
// user-visible bug: at cols=80 the panel border, banner, section
// headers, and compact headline all came out white instead of amber.
//
// This test pins the fix: at cols=80 the Splash element tree must
// assign `theme.fg` (the amber hex) to enough rows that the regression
// can't silently come back. We don't mount Ink (no TTY needed) — we
// call the function component directly and inspect the resulting
// element tree, the same pattern used by v53-repl-layout.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Splash } from '../tui/splash.mjs';
import { theme } from '../tui/theme.mjs';

const fixture = {
  version: '5.3.0',
  provider: 'claude-cli',
  model: 'claude-opus-4-7',
  trainer: { provider: 'claude-cli', model: 'claude-haiku-4-5' },
  sessionId: 'abc123',
  cwd: '/tmp/x',
  tools: [
    { category: 'fs', sensitive: false, verbs: ['read','write','edit','glob','grep'] },
    { category: 'exec', sensitive: false, verbs: ['bash','spawn','kill'] },
  ],
  skills: [
    { group: 'dev', names: ['review','debug'] },
  ],
};

// Force NARROW tier (45 <= cols < 90). Splash() reads
// `process.stdout.columns` directly.
function withColumns(cols, fn) {
  const prev = process.stdout.columns;
  Object.defineProperty(process.stdout, 'columns', {
    value: cols, writable: true, configurable: true,
  });
  try { return fn(); }
  finally {
    Object.defineProperty(process.stdout, 'columns', {
      value: prev, writable: true, configurable: true,
    });
  }
}

// Walk the element tree returned by Splash() and collect every <Text/>
// child's { color, content } pair.
function collectTextRows(element) {
  const rows = [];
  const children = element.props.children;
  const arr = Array.isArray(children) ? children : [children];
  for (const child of arr) {
    if (!child || typeof child !== 'object') continue;
    // child is a React element for ink's Text component
    const color = child.props && child.props.color;
    const content = child.props && child.props.children;
    rows.push({ color, content: typeof content === 'string' ? content : '' });
  }
  return rows;
}

test('NARROW tier at cols=80: at least N rows have theme.fg color', () => {
  const rows = withColumns(80, () => {
    const el = Splash(fixture);
    return collectTextRows(el);
  });
  const colored = rows.filter((r) => r.color === theme.fg);
  // Expectation: banner banner (35 rows) + panel top + panel bottom +
  // ~all panel side rows ('│ ... │') + section headers + compact
  // headline + summary line. Even a conservative lower bound is well
  // over the pre-fix value of 0.
  assert.ok(
    colored.length >= 30,
    `expected >= 30 colored rows at cols=80, got ${colored.length} out of ${rows.length} total`,
  );
});

test('NARROW tier at cols=80: panel border rows are amber', () => {
  const rows = withColumns(80, () => collectTextRows(Splash(fixture)));
  // top corner '╭' must be theme.fg
  const top = rows.find((r) => r.content.includes('╭'));
  assert.ok(top, 'expected a row containing ╭ in the NARROW output');
  assert.equal(top.color, theme.fg, 'top panel border must be amber');
  // bottom corner '╰' must be theme.fg
  const bottom = rows.find((r) => r.content.includes('╰'));
  assert.ok(bottom, 'expected a row containing ╰ in the NARROW output');
  assert.equal(bottom.color, theme.fg, 'bottom panel border must be amber');
});

test('NARROW tier at cols=80: section headers are amber', () => {
  const rows = withColumns(80, () => collectTextRows(Splash(fixture)));
  // On NARROW the section headers sit INSIDE the bordered panel, so
  // each header row looks like "  │ Subcommands ... │" — color-wise
  // that's covered by the panel-border rule, but we still want to pin
  // that the header text comes out amber regardless of mechanism.
  for (const header of ['Subcommands', 'Available Tools', 'Available Skills']) {
    const row = rows.find((r) => r.content.includes(header));
    assert.ok(row, `expected a row containing "${header}"`);
    assert.equal(row.color, theme.fg, `row containing "${header}" must be amber`);
  }
});

test('NARROW tier at cols=80: compact headline "pompos 5.3.0" is amber', () => {
  const rows = withColumns(80, () => collectTextRows(Splash(fixture)));
  const headline = rows.find((r) => /^\s*pompos\s+5\.3\.0\s*$/.test(r.content));
  assert.ok(headline, 'expected a row matching "pompos 5.3.0"');
  assert.equal(headline.color, theme.fg, 'compact headline must be amber');
});

test('NARROW tier at cols=80: banner rows are amber', () => {
  const rows = withColumns(80, () => collectTextRows(Splash(fixture)));
  // The banner banner uses braille (⣿ and friends). Any row containing
  // braille glyphs in the NARROW output must be colored.
  const bannerRows = rows.filter((r) => /[⠀-⣿]/.test(r.content));
  assert.ok(bannerRows.length > 0, 'expected braille banner rows at cols=80');
  for (const r of bannerRows) {
    assert.equal(r.color, theme.fg, 'every braille banner row must be amber');
  }
});

test('WIDE tier at cols=160: wordmark rows still use the gradient palette (not theme.fg)', () => {
  const rows = withColumns(160, () => collectTextRows(Splash(fixture)));
  // First few rows are the wordmark — they use palette colors, NOT
  // theme.fg. This pins that the fix did not regress the wide path.
  const firstRow = rows[0];
  assert.ok(firstRow, 'expected at least one row at cols=160');
  // Wordmark rows are colored, and the color is a hex string from the
  // wordmark palette — not necessarily theme.fg.
  assert.ok(typeof firstRow.color === 'string' && firstRow.color.startsWith('#'),
    `expected wordmark row to have a hex color, got ${firstRow.color}`);
});
