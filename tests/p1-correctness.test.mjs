// P1 correctness — persisted state parsing is crash-safe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadState, saveState, statePath } from '../workflow/persistent.mjs';

test('loadState returns null on a corrupt state file (no SyntaxError out of inspect/resume)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-c5-'));
  const p = statePath('sess', dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{ this is not valid json');
  assert.equal(loadState('sess', dir), null);
});

test('loadState returns null for a missing session', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-c5b-'));
  assert.equal(loadState('nope', dir), null);
});

test('loadState round-trips a valid state written by saveState', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-c5c-'));
  saveState({ sessionId: 's', order: ['a'], nodes: { a: { status: 'success' } }, startedAt: 1, updatedAt: 1 }, dir);
  const got = loadState('s', dir);
  assert.equal(got.sessionId, 's');
  assert.equal(got.nodes.a.status, 'success');
});
