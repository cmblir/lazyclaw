// tests/f-config-set-nested.test.mjs — `pompos config set <key> <value>` got
// a dotted key wrong: `config set chat.recall false` stored a literal flat key
// "chat.recall": "false" (string) instead of nesting it as chat: { recall:
// false } (boolean). cmdConfigSet now writes the nested path AND coerces the
// value (true/false → boolean, integer/float → number, else string). Flat
// (non-dotted) keys keep their exact previous behaviour.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from '../lib/config.mjs';
import { cmdConfigSet } from '../commands/config.mjs';

function withTmpConfig(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-cfg-set-'));
  const prev = process.env.LAZYCLAW_CONFIG_DIR;
  process.env.LAZYCLAW_CONFIG_DIR = dir;
  // cmdConfigSet logs a JSON line on success; swallow it to keep test output clean.
  const origLog = console.log;
  console.log = () => {};
  try {
    fn(dir);
  } finally {
    console.log = origLog;
    if (prev === undefined) delete process.env.LAZYCLAW_CONFIG_DIR;
    else process.env.LAZYCLAW_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('config set on a dotted key writes a nested path with a coerced boolean', () => {
  withTmpConfig(() => {
    cmdConfigSet('chat.recall', 'false');
    const cfg = readConfig();
    assert.equal(typeof cfg.chat, 'object', 'chat must be a nested object, not a flat key');
    assert.equal(cfg.chat.recall, false, 'value must be the boolean false');
    assert.ok(!('chat.recall' in cfg), 'no literal flat "chat.recall" key may exist');
  });
});

test('config set coerces true/false/numbers and keeps non-numeric strings as strings', () => {
  withTmpConfig(() => {
    cmdConfigSet('chat.recall', 'true');
    cmdConfigSet('limits.maxTurns', '12');
    cmdConfigSet('limits.temperature', '0.5');
    cmdConfigSet('chat.persona', 'concise');
    const cfg = readConfig();
    assert.equal(cfg.chat.recall, true);
    assert.equal(cfg.limits.maxTurns, 12);
    assert.equal(cfg.limits.temperature, 0.5);
    assert.equal(cfg.chat.persona, 'concise');
    assert.equal(typeof cfg.chat.persona, 'string');
  });
});

test('config set on a flat key keeps existing string behaviour (no regression)', () => {
  withTmpConfig(() => {
    cmdConfigSet('provider', 'mock');
    cmdConfigSet('api-key', 'sk-test-xyz');
    cmdConfigSet('model', 'claude-haiku-4-5-20251001');
    const cfg = readConfig();
    assert.equal(cfg.provider, 'mock');
    assert.equal(cfg['api-key'], 'sk-test-xyz');
    assert.equal(cfg.model, 'claude-haiku-4-5-20251001');
  });
});

test('config set merges a second nested key under an existing parent', () => {
  withTmpConfig(() => {
    cmdConfigSet('chat.recall', 'false');
    cmdConfigSet('chat.persona', 'concise');
    const cfg = readConfig();
    assert.equal(cfg.chat.recall, false, 'the first nested key survives the second set');
    assert.equal(cfg.chat.persona, 'concise');
  });
});

test('config set coerces a flat boolean/number too (dotting is not required to coerce)', () => {
  withTmpConfig(() => {
    cmdConfigSet('verbose', 'true');
    const cfg = readConfig();
    assert.equal(cfg.verbose, true);
  });
});
