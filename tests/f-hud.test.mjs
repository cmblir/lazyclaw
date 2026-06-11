// tests/f-hud.test.mjs — the claude-hud-style status row: real-time usage +
// configured models (chat/trainer) + orchestrator, toggleable via /config or
// /hud. Default on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { hudEnabled, hudStatus, formatHudRow, hudSlash } from '../tui/hud.mjs';

test('hudEnabled: default on, off only when cfg.chat.hud === false', () => {
  assert.equal(hudEnabled({}), true);
  assert.equal(hudEnabled({ chat: {} }), true);
  assert.equal(hudEnabled({ chat: { hud: false } }), false);
  assert.equal(hudEnabled({ chat: { hud: true } }), true);
});

test('hudStatus: null when disabled, fields when on', () => {
  assert.equal(hudStatus({ chat: { hud: false } }, {}), null);
  const f = hudStatus({ provider: 'codex-cli', model: 'gpt-5.5' }, { inputTokens: 1500, outputTokens: 200 });
  assert.equal(f.inTok, 1500);
  assert.equal(f.outTok, 200);
});

test('hudStatus: cost from a rate card; orchestrator shape when active', () => {
  const rated = hudStatus(
    { provider: 'openai', model: 'gpt-4.1', rates: { 'openai/gpt-4.1': { inputPer1M: 2, outputPer1M: 8 } } },
    { inputTokens: 1_000_000, outputTokens: 1_000_000 },
  );
  assert.equal(rated.costUsd, 10); // 1M*2 + 1M*8 per million = 10
  const orch = hudStatus({ provider: 'orchestrator', orchestrator: { planner: 'claude-cli', workers: ['a', 'b'] } }, {});
  assert.match(orch.orch, /claude-cli \+2w/);
});

test('formatHudRow: usage always, cost/trainer/orch conditional', () => {
  assert.match(formatHudRow({ inTok: 1200, outTok: 50, costUsd: 0, trainer: '', orch: '' }), /↑1\.2k ↓50 tok/);
  const full = formatHudRow({ inTok: 0, outTok: 0, costUsd: 0.0123, trainer: 'claude-cli', orch: 'x +1w' });
  assert.match(full, /\$0\.0123/);
  assert.match(full, /trainer claude-cli/);
  assert.match(full, /orch x \+1w/);
});

test('hudSlash: on/off/toggle persists cfg.chat.hud and mirrors ctx.cfg', async () => {
  const cfg = { chat: {} };
  const ctx = { cfg, readConfig: () => cfg, writeConfig: (n) => Object.assign(cfg, n) };
  assert.equal(await hudSlash('off', ctx), 'HUD off');
  assert.equal(cfg.chat.hud, false);
  assert.equal(ctx.cfg.chat.hud, false);
  assert.equal(await hudSlash('on', ctx), 'HUD on');
  assert.equal(cfg.chat.hud, true);
  assert.equal(await hudSlash('', ctx), 'HUD off'); // no arg, no picker → toggle
  assert.equal(cfg.chat.hud, false);
});
