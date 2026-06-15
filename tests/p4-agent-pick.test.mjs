// tests/p4-agent-pick.test.mjs — /agent edit <name> drills the shared
// provider→model picker and patches the agent record. Before this, an agent's
// provider/model could only be set via CLI --flags; in-chat /agent had no path.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
import { dispatchSlash } from '../tui/slash_dispatcher.mjs';
import { getAgent } from '../agents.mjs';

function scriptedPicker(answers) {
  const q = [...answers];
  return async () => (q.length ? q.shift() : null);
}

test('/agent edit <name> picks provider+model and patches the record', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-agent-'));
  await dispatchSlash('/agent', 'add scout researcher', { cfgDir, cfg: {} }, () => {});
  const ctx = {
    cfgDir, cfg: {}, getActiveProvName: () => 'mock', getActiveModel: () => '',
    resolveAuthKey: () => '',
    openPicker: scriptedPicker(['anthropic', 'claude-opus-4-8']),
  };
  const out = await dispatchSlash('/agent', 'edit scout', ctx, () => {});
  const a = getAgent('scout', cfgDir);
  assert.equal(a.provider, 'anthropic');
  assert.equal(a.model, 'claude-opus-4-8');
  assert.match(out, /scout → anthropic\/claude-opus-4-8/);
});

test('/agent edit on a missing agent reports it', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-agent-'));
  const ctx = { cfgDir, cfg: {}, openPicker: scriptedPicker([]) };
  const out = await dispatchSlash('/agent', 'edit ghost', ctx, () => {});
  assert.match(out, /no agent "ghost"/);
});

test('/agent edit cancel leaves the record unchanged', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-agent-'));
  await dispatchSlash('/agent', 'add scout researcher', { cfgDir, cfg: {} }, () => {});
  const before = getAgent('scout', cfgDir);
  const ctx = {
    cfgDir, cfg: {}, getActiveProvName: () => 'mock', getActiveModel: () => '',
    resolveAuthKey: () => '',
    openPicker: scriptedPicker(['anthropic', null]), // provider then cancel model
  };
  const out = await dispatchSlash('/agent', 'edit scout', ctx, () => {});
  assert.match(out, /cancelled/);
  assert.deepEqual(getAgent('scout', cfgDir).provider, before.provider);
});
