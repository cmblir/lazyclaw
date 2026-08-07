import test from 'node:test';
import assert from 'node:assert/strict';
import { wordmark } from '../tui/wordmark.mjs';
import { renderSplashToString } from '../tui/splash.mjs';
import stringWidth from 'string-width';

const fixture = {
  provider: 'claude-cli',
  model: 'sonnet-4.7',
  trainer: { provider: 'claude-cli', model: 'haiku-4.5' },
  sessionId: '7af9abcd',
  cwd: '/Users/o/code/pompos',
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

test('every rendered line fits within terminal width (Hermes-style hero)', () => {
  const TW = 140;
  const out = renderSplashToString(fixture, { columns: TW });
  for (const [i, line] of out.split('\n').entries()) {
    assert.ok(stringWidth(line) <= TW, `line ${i} width=${stringWidth(line)} > ${TW}`);
  }
});

test('shows chat + trainer provider/model line', () => {
  const out = renderSplashToString(fixture, { columns: 120 });
  assert.match(out, /claude-cli · sonnet-4\.7/);
  assert.match(out, /trainer claude-cli · haiku-4\.5/);
});

test('shows welcome + tip lines', () => {
  const out = renderSplashToString(fixture, { columns: 120 });
  assert.match(out, /Welcome to pompos/);
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

// ---------------------------------------------------------------------------
// Responsive tier tests — WIDE / MEDIUM / NARROW / MINIMAL
// ---------------------------------------------------------------------------

const responsiveFixture = {
  version: '5.0.9',
  provider: 'claude-cli',
  model: 'claude-opus-4-7',
  trainer: { provider: 'claude-cli', model: 'claude-haiku-4-5' },
  sessionId: 'abc123',
  cwd: '/tmp/x',
  tools: [
    { category: 'fs', sensitive: false, verbs: ['read','write','edit','glob','grep'] },
    { category: 'exec', sensitive: false, verbs: ['bash','spawn','kill'] },
    { category: 'admin', sensitive: true, verbs: ['keys','billing'] },
    { category: 'git', sensitive: false, verbs: ['status','diff','log'] },
    { category: 'web', sensitive: false, verbs: ['fetch','search'] },
  ],
  skills: [
    { group: 'dev', names: ['review','debug','simplify'] },
    { group: 'docs', names: ['init','changelog','readme'] },
  ],
};

test('WIDE tier at cols=140 renders wordmark + full panel title chain', () => {
  const out = renderSplashToString(responsiveFixture, { columns: 140 });
  // The wordmark's own first row, read from the module — not a glyph that happens
  // to be in the current lettering. The previous form asserted on '_____', which
  // silently stopped testing anything the moment the wordmark banner changed.
  assert.ok(out.includes(wordmark.rows[0].trimEnd()),
    'expected wordmark to be present at WIDE tier');
  assert.ok(out.includes('trainer-split · FTS5 recall · 6-backend sandbox'),
    'expected TITLE chain in panel top row at WIDE tier');
  // No truncation in the right column when terminal is wide.
  assert.ok(!out.includes('…'), 'expected no ellipsis truncation at WIDE tier');
  for (const [i, line] of out.split('\n').entries()) {
    assert.ok(stringWidth(line) <= 140, `WIDE line ${i} width=${stringWidth(line)} > 140`);
  }
});

test('MEDIUM tier at cols=100 drops wordmark but keeps panel + art, wraps not truncates', () => {
  const out = renderSplashToString(responsiveFixture, { columns: 100 });
  // No wordmark (uses backslash + underscore characters).
  assert.ok(!out.includes('_____'), 'wordmark must be dropped at MEDIUM tier');
  // Compact headline replaces it.
  assert.match(out, /pompos 5\.0\.9/);
  // Panel title is compact (no TITLE chain).
  assert.ok(!out.includes('trainer-split · FTS5 recall'),
    'compact panel must omit TITLE chain at MEDIUM tier');
  // Wrapping, not truncation.
  assert.ok(!out.includes('…'), 'MEDIUM tier wraps verbs instead of truncating');
  for (const [i, line] of out.split('\n').entries()) {
    assert.ok(stringWidth(line) <= 100, `MEDIUM line ${i} width=${stringWidth(line)} > 100`);
  }
});

test('NARROW tier at cols=80 keeps the banner (stacked) + panel and WRAPS verb lists (no truncation)', () => {
  const out = renderSplashToString(responsiveFixture, { columns: 80 });
  assert.ok(!out.includes('_____'), 'wordmark must be absent at NARROW tier');
  // Panel border characters PRESENT in the new stacked-NARROW layout.
  assert.ok(out.includes('╭'), 'top panel border must be present at NARROW tier');
  assert.ok(out.includes('╰'), 'bottom panel border must be present at NARROW tier');
  // Section headers present.
  assert.match(out, /Subcommands/);
  assert.match(out, /Available Tools/);
  assert.match(out, /Available Skills/);
  // No truncation marker — narrow tier wraps verbs across rows instead.
  assert.ok(!out.includes('…'), 'NARROW tier must wrap verbs, not truncate with ellipsis');
  for (const [i, line] of out.split('\n').entries()) {
    assert.ok(stringWidth(line) <= 80, `NARROW line ${i} width=${stringWidth(line)} > 80`);
  }
});

test('MINIMAL tier at cols=44 emits headline + provider + cwd + /help only', () => {
  const out = renderSplashToString(responsiveFixture, { columns: 44 });
  assert.match(out, /pompos 5\.0\.9/);
  assert.match(out, /claude-cli/);
  assert.match(out, /\/help/);
  assert.ok(!out.includes('Subcommands'), 'MINIMAL must drop section headers');
  assert.ok(!out.includes('Available Tools'), 'MINIMAL must drop tools section');
  assert.ok(!out.includes('╭'), 'MINIMAL must drop panel border');
  const lines = out.split('\n');
  assert.ok(lines.length < 8, `MINIMAL must be compact, got ${lines.length} lines`);
  for (const [i, line] of lines.entries()) {
    assert.ok(stringWidth(line) <= 44, `MINIMAL line ${i} width=${stringWidth(line)} > 44`);
  }
});

test('tier boundaries are exact', () => {
  // Identify the wordmark by its own first row rather than by a glyph inside the
  // banner, so this keeps testing the tier boundary when the lettering changes.
  const mark = wordmark.rows[0].trimEnd();
  // cols=140 → WIDE (wordmark present)
  assert.ok(renderSplashToString(responsiveFixture, { columns: 140 }).includes(mark),
    'cols=140 must render WIDE with wordmark');
  // cols=139 → MEDIUM (no wordmark, panel present)
  const at139 = renderSplashToString(responsiveFixture, { columns: 139 });
  assert.ok(!at139.includes(mark), 'cols=139 must drop wordmark');
  assert.ok(at139.includes('╭'), 'cols=139 must keep panel border');
  // cols=90 → MEDIUM (panel present)
  assert.ok(renderSplashToString(responsiveFixture, { columns: 90 }).includes('╭'),
    'cols=90 must keep panel border (MEDIUM tier)');
  // cols=89 → NARROW (panel still present, banner stacked)
  const at89 = renderSplashToString(responsiveFixture, { columns: 89 });
  assert.ok(at89.includes('╭'), 'cols=89 must keep panel border (NARROW tier, stacked)');
  assert.match(at89, /Subcommands/);
  // cols=45 → NARROW (sections present)
  assert.match(renderSplashToString(responsiveFixture, { columns: 45 }), /Subcommands/);
  // cols=44 → MINIMAL (sections absent)
  const at44 = renderSplashToString(responsiveFixture, { columns: 44 });
  assert.ok(!at44.includes('Subcommands'), 'cols=44 must drop sections (MINIMAL tier)');
});

test('no row exceeds requested width at every breakpoint', () => {
  for (const cols of [50, 59, 60, 80, 89, 90, 100, 129, 130, 140, 200]) {
    const out = renderSplashToString(responsiveFixture, { columns: cols });
    for (const [i, line] of out.split('\n').entries()) {
      assert.ok(stringWidth(line) <= cols,
        `cols=${cols} line ${i} width=${stringWidth(line)} > ${cols}: ${JSON.stringify(line)}`);
    }
  }
});
