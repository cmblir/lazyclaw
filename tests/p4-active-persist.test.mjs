// tests/p4-active-persist.test.mjs — a model/provider picked in chat must be
// saved to disk so it survives a restart. Regression: /model mutated the
// in-memory active model only, so the choice reverted to cfg.model on the next
// launch (the "model stuck" report). The setters now route through
// persistActiveModel / persistActiveProvider.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
import { readConfig, writeConfig, persistActiveModel, persistActiveProvider } from '../lib/config.mjs';

function freshCfgDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-persist-'));
  process.env.LAZYCLAW_CONFIG_DIR = dir;
  return dir;
}

test('persistActiveModel writes cfg.model to disk and mirrors liveCfg', () => {
  freshCfgDir();
  const live = {};
  persistActiveModel(live, 'claude-opus-4-8');
  assert.equal(readConfig().model, 'claude-opus-4-8');
  assert.equal(live.model, 'claude-opus-4-8');
});

test('persistActiveModel(null) clears cfg.model (provider default)', () => {
  freshCfgDir();
  writeConfig({ model: 'gpt-4.1', provider: 'openai' });
  const live = { model: 'gpt-4.1' };
  persistActiveModel(live, null);
  const disk = readConfig();
  assert.ok(!('model' in disk), 'cfg.model should be deleted');
  assert.equal(disk.provider, 'openai', 'unrelated keys survive');
  assert.ok(!('model' in live));
});

test('persistActiveProvider writes cfg.provider', () => {
  freshCfgDir();
  const live = {};
  persistActiveProvider(live, 'openai');
  assert.equal(readConfig().provider, 'openai');
  assert.equal(live.provider, 'openai');
});

test('persistActiveProvider does not clobber an active orchestrator provider', () => {
  freshCfgDir();
  writeConfig({ provider: 'orchestrator', orchestrator: { workers: ['anthropic:claude-opus-4-8'] } });
  persistActiveProvider({}, 'anthropic');
  assert.equal(readConfig().provider, 'orchestrator', 'orchestrator routing must stay');
});

test('persistActiveProvider never writes orchestrator itself', () => {
  const dir = freshCfgDir();
  persistActiveProvider({}, 'orchestrator');
  // no-op: no config written, provider not set to orchestrator
  assert.ok(!fs.existsSync(path.join(dir, 'config.json')) || readConfig().provider !== 'orchestrator');
});
