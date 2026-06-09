// tests/f-context-window.test.mjs — chat context-window helpers + the /context
// slash (view/set the sliding history budget).

import test from 'node:test';
import assert from 'node:assert/strict';
import { chatWindowGet, chatWindowSet } from '../config_features.mjs';
import { dispatchSlash } from '../tui/slash_dispatcher.mjs';
import { SLASH_COMMANDS } from '../tui/slash_commands.mjs';

test('chatWindowGet returns defaults for empty config', () => {
  const w = chatWindowGet({});
  assert.equal(w.turns, 20);
  assert.equal(w.tokens, 8000);
});

test('chatWindowGet reflects configured values', () => {
  const w = chatWindowGet({ chat: { windowTurns: 40, windowTokens: 16000 } });
  assert.equal(w.turns, 40);
  assert.equal(w.tokens, 16000);
});

test('chatWindowSet merges only provided keys', () => {
  const cfg = { chat: { windowTurns: 20 } };
  chatWindowSet(cfg, { tokens: 12000 });
  assert.equal(cfg.chat.windowTurns, 20, 'turns preserved');
  assert.equal(cfg.chat.windowTokens, 12000);
});

test('/context status reports turns + tokens', async () => {
  const ctx = { readConfig: () => ({ chat: { windowTurns: 30, windowTokens: 9000 } }), writeConfig: () => {} };
  const out = await dispatchSlash('/context', '', ctx, () => {});
  assert.match(out, /30 turns/);
  assert.match(out, /9000 tokens/);
});

test('/context tokens <N> persists via writeConfig', async () => {
  const cfg = {};
  const ctx = { readConfig: () => cfg, writeConfig: (c) => Object.assign(cfg, c) };
  const out = await dispatchSlash('/context', 'tokens 16000', ctx, () => {});
  assert.match(out, /16000 tokens/);
  assert.equal(cfg.chat.windowTokens, 16000);
});

test('/context tokens rejects below the floor', async () => {
  const ctx = { readConfig: () => ({}), writeConfig: () => { throw new Error('should not write'); } };
  const out = await dispatchSlash('/context', 'tokens 10', ctx, () => {});
  assert.match(out, /min 256/);
});

test('/context is in the slash catalog', () => {
  assert.ok(SLASH_COMMANDS.some((c) => c.cmd === '/context'));
});
