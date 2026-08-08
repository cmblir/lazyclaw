// tests/f-config-corruption.test.mjs — readConfig must distinguish a MISSING
// config.json (legitimately fresh → {}) from a PRESENT-BUT-CORRUPT one. A typo
// in config.json must fail loudly instead of silently returning {} (which drops
// every setting and lets a later writeConfig clobber the recoverable file).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig, ConfigError } from '../lib/config.mjs';

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-cfg-corrupt-'));
}

test('readConfig returns {} when config.json is missing (fresh install)', () => {
  const dir = mkTmpDir();
  const prev = process.env.POMPOS_CONFIG_DIR;
  process.env.POMPOS_CONFIG_DIR = dir;
  try {
    assert.deepEqual(readConfig(), {});
  } finally {
    if (prev === undefined) delete process.env.POMPOS_CONFIG_DIR;
    else process.env.POMPOS_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readConfig fails loudly (does NOT return {}) on a corrupt config.json and leaves the file intact', () => {
  const dir = mkTmpDir();
  const prev = process.env.POMPOS_CONFIG_DIR;
  process.env.POMPOS_CONFIG_DIR = dir;
  const p = path.join(dir, 'config.json');
  // A real-world typo: trailing comma + unquoted value. Carries recoverable
  // settings (provider/key) that must NOT be silently dropped or overwritten.
  const corruptBytes = '{ "provider": "anthropic", "api-key": "sk-keep-me", }';
  fs.writeFileSync(p, corruptBytes);

  // Capture stderr to assert the loud, actionable warning.
  const origErr = process.stderr.write.bind(process.stderr);
  let stderr = '';
  process.stderr.write = (chunk, ...rest) => {
    stderr += typeof chunk === 'string' ? chunk : chunk.toString();
    return origErr(chunk, ...rest);
  };

  try {
    let result, threw = false, err;
    try {
      result = readConfig();
    } catch (e) {
      threw = true;
      err = e;
    }

    // Must NOT silently return {} — that is the bug being pinned.
    assert.ok(!(threw === false && JSON.stringify(result) === '{}'),
      'corrupt config.json must not silently return {}');
    assert.ok(threw, 'readConfig should throw on a present-but-corrupt config.json');
    assert.ok(err instanceof ConfigError, 'should throw a typed ConfigError');

    // Loud + actionable: names the path, the parse error, and how to recover.
    assert.match(stderr, new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'warning names the config path');
    assert.match(stderr, /fix the JSON|move it aside/i, 'warning explains how to recover');

    // The corrupt file must be left EXACTLY as written — no clobber.
    assert.equal(fs.readFileSync(p, 'utf8'), corruptBytes,
      'corrupt config.json bytes must be unchanged after readConfig');
  } finally {
    process.stderr.write = origErr;
    if (prev === undefined) delete process.env.POMPOS_CONFIG_DIR;
    else process.env.POMPOS_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
