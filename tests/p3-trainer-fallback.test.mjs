// tests/p3-trainer-fallback.test.mjs — P3 restore: resolveTrainer honors a
// `trainer.fallback` ("provider:model") knob, but /trainer set only ever
// wrote provider+model, so the fallback routing was unreachable from the
// REPL. Add `--fallback` to set and a `/trainer fallback` sub.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { dispatchSlash } from '../tui/slash_dispatcher.mjs';

function makeCtx() {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-trainer-'));
  const PROVIDERS = { openai: {}, anthropic: {}, ollama: {} };
  return {
    cfgDir,
    cfg: {},
    registryMod: {
      PROVIDERS,
      lookupProv: (n) => PROVIDERS[n] || null,
      parseProviderModel: (s) => {
        const i = String(s).indexOf(':');
        if (i < 0) return { provider: s || null, model: null };
        return { provider: s.slice(0, i) || null, model: s.slice(i + 1) || null };
      },
    },
    getActiveProvName: () => 'ollama',
    getActiveModel: () => 'llama3.1',
  };
}

function readCfg(ctx) {
  return JSON.parse(fs.readFileSync(path.join(ctx.cfgDir, 'config.json'), 'utf8'));
}

test('/trainer set <p:m> --fallback <p:m> persists the fallback', async () => {
  const ctx = makeCtx();
  const out = await dispatchSlash('/trainer', 'set openai:gpt-4.1 --fallback anthropic:claude-opus-4-7', ctx);
  assert.match(out, /trainer →/);
  const t = readCfg(ctx).trainer;
  assert.equal(t.provider, 'openai');
  assert.equal(t.model, 'gpt-4.1');
  assert.equal(t.fallback, 'anthropic:claude-opus-4-7');
  assert.equal(ctx.cfg.trainer.fallback, 'anthropic:claude-opus-4-7');
});

test('/trainer fallback <p:m> sets fallback on an existing trainer', async () => {
  const ctx = makeCtx();
  await dispatchSlash('/trainer', 'set openai:gpt-4.1', ctx);
  const out = await dispatchSlash('/trainer', 'fallback ollama:llama3.1', ctx);
  assert.match(out, /fallback →/);
  assert.equal(readCfg(ctx).trainer.fallback, 'ollama:llama3.1');
});

test('/trainer fallback clear removes only the fallback', async () => {
  const ctx = makeCtx();
  await dispatchSlash('/trainer', 'set openai:gpt-4.1 --fallback ollama:llama3.1', ctx);
  const out = await dispatchSlash('/trainer', 'fallback clear', ctx);
  assert.match(out, /fallback cleared/);
  const t = readCfg(ctx).trainer;
  assert.equal(t.fallback, undefined);
  assert.equal(t.provider, 'openai', 'trainer provider untouched');
});

test('/trainer set --fallback with an unknown provider is rejected', async () => {
  const ctx = makeCtx();
  const out = await dispatchSlash('/trainer', 'set openai --fallback nope:x', ctx);
  assert.match(out, /unknown provider/);
});
