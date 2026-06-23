import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamingIndicator, BLINK_MS } from '../tui/status_bar.mjs';

const t = { success: (s) => `G:${s}`, accent: (s) => `A:${s}`, dim: (s) => `D:${s}` };

test('idle shows a steady hollow dot regardless of blink phase', () => {
  assert.equal(streamingIndicator(false, true, t), 'D:○ idle');
  assert.equal(streamingIndicator(false, false, t), 'D:○ idle');
});

test('streaming pulses the dot between GREEN (bright) and dim — not amber accent', () => {
  assert.equal(streamingIndicator(true, true, t), 'G:● streaming');   // bright = green
  assert.equal(streamingIndicator(true, false, t), 'D:● streaming');  // dim phase
  assert.notEqual(streamingIndicator(true, true, t), streamingIndicator(true, false, t));
});

test('BLINK_MS is a sane pulse interval', () => {
  assert.ok(BLINK_MS >= 200 && BLINK_MS <= 1000);
});
