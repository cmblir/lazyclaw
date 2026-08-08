import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('readConfig is mtime-cached but hands out independent, mutation-safe clones', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-cfgcache-'));
  process.env.POMPOS_CONFIG_DIR = d;
  const { readConfig, writeConfig, _invalidateConfigCache } = await import('../lib/config.mjs');
  _invalidateConfigCache();

  writeConfig({ provider: 'claude-cli', n: 1, nested: { a: 1 } });
  const a = readConfig();
  const b = readConfig();
  assert.equal(a.n, 1);
  assert.equal(b.n, 1);
  assert.notEqual(a, b, 'each read returns an independent object (clone)');
  assert.notEqual(a.nested, b.nested, 'nested objects are cloned too');

  // mutating one caller's copy must not corrupt the cache
  a.n = 999; a.nested.a = 999;
  const c = readConfig();
  assert.equal(c.n, 1, 'cache not corrupted by a caller mutation');
  assert.equal(c.nested.a, 1);

  // writeConfig invalidates → next read reflects the new content
  writeConfig({ provider: 'claude-cli', n: 2 });
  assert.equal(readConfig().n, 2, 'writeConfig invalidates the cache');

  fs.rmSync(d, { recursive: true, force: true });
  delete process.env.POMPOS_CONFIG_DIR;
});
