// tests/f-hud-live-meter.test.mjs — while a turn streams, the HUD row shows
// throughput next to the existing token/cost fields.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatHudRow, formatRate } from '../tui/hud.mjs';

const fields = { inTok: 1200, outTok: 340, costUsd: 0.0123, trainer: 'claude-cli', orch: '' };

test('formatRate reports characters per second', () => {
  assert.equal(formatRate(1000, 1000), '1000/s');
  assert.equal(formatRate(500, 2000), '250/s');
  assert.equal(formatRate(12_500, 1000), '12.5k/s');
});

test('formatRate returns empty for a meaningless sample', () => {
  assert.equal(formatRate(0, 1000), '');
  assert.equal(formatRate(100, 0), '');
  assert.equal(formatRate(100, 150), '', 'samples under 250ms are too noisy to show');
});

test('formatHudRow is unchanged without a live sample', () => {
  const out = formatHudRow(fields);
  assert.match(out, /↑1.2k ↓340 tok/);
  assert.match(out, /\$0.0123/);
  assert.doesNotMatch(out, /⇅/);
});

test('formatHudRow appends the rate segment during a stream', () => {
  const out = formatHudRow(fields, { chars: 5000, elapsedMs: 2000 });
  assert.match(out, /⇅ 2500\/s/);
  assert.match(out, /↑1.2k ↓340 tok/, 'existing segments must survive');
});

test('formatHudRow drops the rate segment when the sample is meaningless', () => {
  assert.doesNotMatch(formatHudRow(fields, { chars: 0, elapsedMs: 5000 }), /⇅/);
  assert.doesNotMatch(formatHudRow(fields, {}), /⇅/);
});

test('formatHudRow still returns empty for no fields', () => {
  assert.equal(formatHudRow(null), '');
  assert.equal(formatHudRow(null, { chars: 100, elapsedMs: 1000 }), '');
});
