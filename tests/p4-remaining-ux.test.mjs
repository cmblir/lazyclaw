// tests/p4-remaining-ux.test.mjs — the last UX-audit batch:
// personality install guided, orchestrator typed-without-spec → picker,
// /trainer set picker → optional fallback prompt, setup --only/--skip gating.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
import { dispatchSlash } from '../tui/slash_dispatcher.mjs';
import { orchestratorSlash } from '../tui/orchestrator_flow.mjs';

function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-rem-')); process.env.POMPOS_CONFIG_DIR = d; return d; }
function scripted(answers) {
  const q = [...answers];
  return async (opts) => {
    const next = q.shift();
    if (next === null || next === undefined) return null;
    if (opts.kind === 'text') return { id: '__text__', query: next };
    return next;
  };
}

test('/personality install guided: prompts name + source file', async () => {
  const cfgDir = tmp();
  const src = path.join(cfgDir, 'src.md');
  fs.writeFileSync(src, '# pirate persona');
  const ctx = { cfgDir, cfg: {}, openPicker: scripted(['pirate', src]) };
  const out = await dispatchSlash('/personality', 'install', ctx, () => {});
  assert.match(out, /installed pirate/);
  assert.ok(fs.existsSync(path.join(cfgDir, 'personalities', 'pirate.md')));
});

test('/personality install guided: retries on a bad path then cancels', async () => {
  const cfgDir = tmp();
  const ctx = { cfgDir, cfg: {}, openPicker: scripted(['p', '/no/such/a.md', '/no/such/b.md', null]) };
  const out = await dispatchSlash('/personality', 'install', ctx, () => {});
  assert.match(out, /cancelled|not found/);
});

test('/orchestrator planner with no spec opens the picker', async () => {
  const cfg = { provider: 'claude-cli', orchestrator: {} };
  let opened = false;
  const ctx = {
    readConfig: () => cfg, writeConfig: (n) => Object.assign(cfg, n), cfg,
    resolveAuthKey: () => '',
    openPicker: async (opts) => { opened = true; return opts.kind === 'menu' && /provider|planner/i.test(opts.title || '') ? 'openai' : 'gpt-4.1'; },
  };
  const out = await orchestratorSlash('planner', ctx);
  assert.ok(opened, 'picker was opened for a spec-less planner');
  assert.match(out, /planner/);
});

test('/orchestrator planner WITH spec stays typed (no picker)', async () => {
  const cfg = { provider: 'claude-cli', orchestrator: {} };
  const ctx = { readConfig: () => cfg, writeConfig: (n) => Object.assign(cfg, n), cfg };
  const out = await orchestratorSlash('planner openai:gpt-4.1', ctx);
  assert.match(out, /planner → openai:gpt-4\.1/);
});

test('/trainer set picker offers an optional fallback', async () => {
  const cfgDir = tmp();
  // primary: provider anthropic, model claude-opus-4-8 ; confirm fallback YES ;
  // fallback: provider openai, model gpt-4.1
  const q = ['anthropic', 'claude-opus-4-8', 'approve', 'openai', 'gpt-4.1'];
  const ctx = {
    cfgDir, cfg: {}, getActiveProvName: () => 'anthropic', getActiveModel: () => '', resolveAuthKey: () => '',
    openPicker: async (opts) => {
      const n = q.shift();
      if (opts.kind === 'text') return { id: '__text__', query: n };
      if (n === 'approve') return { id: 'approve' }; // _promptConfirm yes
      return n;
    },
  };
  const out = await dispatchSlash('/trainer', 'set', ctx, () => {});
  const disk = JSON.parse(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8'));
  assert.equal(disk.trainer.provider, 'anthropic');
  assert.ok(disk.trainer.fallback, 'fallback was set via the prompt');
  assert.match(out, /trainer → anthropic/);
});
