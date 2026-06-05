import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import { banner } from '../tui/banner.generated.mjs';

test('banner exports rows array', () => {
  assert.ok(Array.isArray(banner.rows));
  assert.ok(banner.rows.length > 0);
});

test('every banner row has string-width matching declared width', () => {
  for (const [i, row] of banner.rows.entries()) {
    const w = stringWidth(row);
    assert.ok(w <= banner.width, `row ${i} width=${w} > banner.width=${banner.width} content=${JSON.stringify(row)}`);
  }
});

test('banner declares width/height/fg consistent with rows', () => {
  assert.ok(typeof banner.width === 'number' && banner.width > 0);
  assert.ok(typeof banner.height === 'number' && banner.height > 0);
  assert.equal(banner.fg, '#FFB347');
  assert.equal(banner.rows.length, banner.height);
});
