// tests/f-ctx-gauge-pct.test.mjs — the status-bar/HUD context gauge must show a
// percentage + a tiny inline bar (not just raw token counts) and visibly mark a
// near-full window. Pins the pre-fix gap: `formatGauge` produced no percentage
// and no bar glyph, so the user could not gauge fullness at a glance.

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatGauge } from '../tui/hud.mjs';

// Strip ANSI escape codes so content assertions don't depend on chalk's level
// (which is 0 / off under non-TTY + NO_COLOR test runs).
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

const FILLED = '▰';
const EMPTY = '▱';

test('formatGauge: includes a percentage for a known used/budget pair', () => {
  const out = stripAnsi(formatGauge(1860, 8000));
  // 1860 / 8000 = 23.25% → "23%"
  assert.match(out, /23%/, 'gauge shows the rounded percentage');
});

test('formatGauge: includes an inline bar glyph', () => {
  const out = stripAnsi(formatGauge(1860, 8000));
  assert.ok(out.includes(FILLED) || out.includes(EMPTY), 'gauge renders a bar of block glyphs');
});

test('formatGauge: still surfaces compact token counts', () => {
  const out = stripAnsi(formatGauge(1860, 8000));
  // Compact form via the shared fmtTok (one-decimal k): 1.9k / 8.0k.
  assert.match(out, /1\.9k/);
  assert.match(out, /8\.0k/);
});

test('formatGauge: a >=80% case is marked differently from a 10% case', () => {
  const low = formatGauge(800, 8000);   // 10%
  const high = formatGauge(6800, 8000); // 85% → warn
  assert.notEqual(low, high, 'warn threshold changes the rendering');
  // The warn marker survives ANSI stripping (so NO_COLOR users still see it),
  // and is absent from the calm low-usage gauge.
  const lowPlain = stripAnsi(low);
  const highPlain = stripAnsi(high);
  assert.notEqual(lowPlain, highPlain, 'warn case differs even with color stripped');
});

test('formatGauge: a >=95% case escalates beyond the >=80% warn case', () => {
  const warn = formatGauge(6800, 8000); // 85%
  const danger = formatGauge(7700, 8000); // 96%
  assert.notEqual(stripAnsi(warn), stripAnsi(danger), 'danger renders differently from warn');
});

test('formatGauge: missing/zero budget degrades to a safe placeholder', () => {
  assert.equal(stripAnsi(formatGauge(null, null)), '--');
  assert.equal(stripAnsi(formatGauge(100, 0)), '--');
});
