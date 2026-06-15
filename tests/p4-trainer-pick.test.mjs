// tests/p4-trainer-pick.test.mjs — /trainer set|fallback with no spec opens the
// shared provider→model picker (instead of requiring a hand-typed spec) and
// persists the choice through the existing read-merge-write path.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
import { dispatchSlash } from '../tui/slash_dispatcher.mjs';

function tmpCfgDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-trainer-')); }

// Scripted modal: returns the queued answers in order (provider, then model).
function scriptedPicker(answers) {
  const q = [...answers];
  return async () => (q.length ? q.shift() : null);
}

test('/trainer set with no spec opens the picker and persists the choice', async () => {
  const cfgDir = tmpCfgDir();
  const ctx = {
    cfgDir, cfg: {},
    getActiveProvName: () => 'anthropic', getActiveModel: () => '',
    resolveAuthKey: () => '',
    openPicker: scriptedPicker(['anthropic', 'claude-opus-4-8']),
  };
  const out = await dispatchSlash('/trainer', 'set', ctx, () => {});
  const disk = JSON.parse(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8'));
  assert.equal(disk.trainer.provider, 'anthropic');
  assert.equal(disk.trainer.model, 'claude-opus-4-8');
  assert.match(out, /trainer → anthropic:claude-opus-4-8/);
});

test('/trainer set picker auto row persists provider:auto', async () => {
  const cfgDir = tmpCfgDir();
  const ctx = {
    cfgDir, cfg: {},
    getActiveProvName: () => 'anthropic', getActiveModel: () => '',
    resolveAuthKey: () => '',
    openPicker: scriptedPicker(['__auto__']),
  };
  const out = await dispatchSlash('/trainer', 'set', ctx, () => {});
  const disk = JSON.parse(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8'));
  assert.equal(disk.trainer.provider, 'auto');
  assert.ok(!disk.trainer.model);
  assert.match(out, /trainer → auto/);
});

test('/trainer set picker cancel writes nothing', async () => {
  const cfgDir = tmpCfgDir();
  const ctx = {
    cfgDir, cfg: {},
    getActiveProvName: () => 'anthropic', getActiveModel: () => '',
    resolveAuthKey: () => '',
    openPicker: scriptedPicker(['anthropic', null]), // pick provider, cancel model
  };
  const out = await dispatchSlash('/trainer', 'set', ctx, () => {});
  assert.match(out, /cancelled/);
  assert.ok(!fs.existsSync(path.join(cfgDir, 'config.json')));
});
