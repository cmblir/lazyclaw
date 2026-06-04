import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import { banner } from '../tui/banner.generated.mjs';

test('banner exports rows array', () => {
  assert.ok(Array.isArray(banner.rows));
  assert.ok(banner.rows.length > 0);
});

test('every banner row has string-width <= 24', () => {
  for (const [i, row] of banner.rows.entries()) {
    const w = stringWidth(row);
    assert.ok(w <= 24, `row ${i} width=${w} content=${JSON.stringify(row)}`);
  }
});

test('banner declares width=24, height<=12, fg=#FFB347', () => {
  assert.equal(banner.width, 24);
  assert.ok(banner.height <= 12);
  assert.equal(banner.fg, '#FFB347');
});
