// tests/p1-modal-picker.test.mjs — P1 restore: modal-picker primitives that
// let /model offer a live-fetch row and a free-text "type a custom model id"
// row inside the existing Ink modal (no new input component).
//
//   · filterModalItems must keep `pinned` rows visible even when the filter
//     query matches none of their text — the custom-model row stays on
//     screen while the user types the id into the filter buffer.
//   · resolveModalPick returns the typed filter text alongside a `freeText`
//     row's id so the dispatcher can use it as the custom model id.

import test from 'node:test';
import assert from 'node:assert/strict';

import { filterModalItems, resolveModalPick } from '../tui/modal_filter.mjs';

// ─── filterModalItems pinned ───────────────────────────────────────────────

test('filterModalItems keeps pinned rows when the query matches nothing else', () => {
  const items = [
    { id: '__fetch__', label: 'fetch live models', pinned: true },
    { id: 'gpt-4.1', label: 'gpt-4.1' },
    { id: 'gpt-4o', label: 'gpt-4o' },
    { id: '__custom__', label: 'type a custom model id', pinned: true, freeText: true },
  ];
  const out = filterModalItems('zzz-nonexistent', items);
  assert.deepEqual(out.map((i) => i.id), ['__fetch__', '__custom__']);
});

test('filterModalItems keeps matches first, then pinned rows at the end', () => {
  const items = [
    { id: '__fetch__', label: 'fetch live models', pinned: true },
    { id: 'gpt-4.1', label: 'gpt-4.1' },
    { id: 'gpt-4o', label: 'gpt-4o' },
    { id: '__custom__', label: 'type a custom model id', pinned: true, freeText: true },
  ];
  const out = filterModalItems('gpt-4o', items);
  assert.deepEqual(out.map((i) => i.id), ['gpt-4o', '__fetch__', '__custom__']);
});

test('filterModalItems with empty query returns the full list in original order', () => {
  const items = [
    { id: '__fetch__', label: 'fetch live models', pinned: true },
    { id: 'gpt-4.1', label: 'gpt-4.1' },
  ];
  assert.deepEqual(filterModalItems('', items).map((i) => i.id), ['__fetch__', 'gpt-4.1']);
});

// ─── resolveModalPick ──────────────────────────────────────────────────────

test('resolveModalPick returns a plain id for normal rows', () => {
  assert.equal(resolveModalPick({ id: 'gpt-4.1', label: 'gpt-4.1' }, 'gpt'), 'gpt-4.1');
});

test('resolveModalPick returns {id, query} for a freeText row, carrying the typed filter', () => {
  assert.deepEqual(
    resolveModalPick({ id: '__custom__', freeText: true }, 'qwen3.5-instruct:9b'),
    { id: '__custom__', query: 'qwen3.5-instruct:9b' },
  );
});

test('resolveModalPick returns null when nothing is selected', () => {
  assert.equal(resolveModalPick(undefined, 'anything'), null);
  assert.equal(resolveModalPick(null, ''), null);
});
