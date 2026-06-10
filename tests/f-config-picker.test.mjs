// tests/f-config-picker.test.mjs — the /setup ↔ /config split.
//   /setup  — full wizard (the behavior /config used to have).
//   /config — pick ONE setting; in-chat items delegate to their slash
//             handlers, credential items unmount with requestConfigStep,
//             and the legacy path (no modal picker) falls back to the wizard.

import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchSlash } from '../tui/slash_dispatcher.mjs';
import { runConfigSlash, CONFIG_ITEMS } from '../tui/config_picker.mjs';
import { SLASH_COMMANDS } from '../tui/slash_commands.mjs';
import { legacySlashRoute } from '../commands/chat.mjs';

test('catalog lists both /setup and /config with the new split', () => {
  const setup = SLASH_COMMANDS.find((c) => c.cmd === '/setup');
  const config = SLASH_COMMANDS.find((c) => c.cmd === '/config');
  assert.ok(setup && /full|every/i.test(setup.help), '/setup = full wizard');
  assert.ok(config && /ONE setting/i.test(config.help), '/config = single setting');
});

test('/setup (ink dispatcher) signals the full wizard and unmounts', async () => {
  const ctx = {};
  const r = await dispatchSlash('/setup', '', ctx, () => {});
  assert.equal(r, 'EXIT');
  assert.equal(ctx.requestSetup, true);
});

test('/config without a modal picker falls back to the full wizard (legacy)', async () => {
  const ctx = {};
  const r = await dispatchSlash('/config', '', ctx, () => {});
  assert.equal(r, 'EXIT');
  assert.equal(ctx.requestSetup, true);
});

test('legacy readline route handles BOTH /setup and /config', () => {
  for (const cmd of ['/setup', '/config']) {
    const ctx = {};
    assert.equal(legacySlashRoute(cmd, ctx), 'EXIT');
    assert.equal(ctx.requestSetup, true, cmd);
  }
});

test('/config picker: "wizard" row = full wizard; credential rows set requestConfigStep', async () => {
  for (const [pick, expect] of [
    ['wizard', { requestSetup: true }],
    ['channel', { requestConfigStep: 'channel' }],
    ['webhook', { requestConfigStep: 'webhook' }],
  ]) {
    const ctx = { openPicker: async () => pick };
    const r = await runConfigSlash('', ctx, new Map());
    assert.equal(r, 'EXIT', pick);
    for (const [k, v] of Object.entries(expect)) assert.equal(ctx[k], v, `${pick} → ${k}`);
  }
});

test('/config picker: in-chat items delegate to their slash handlers', async () => {
  const called = [];
  const handlers = new Map(
    ['provider', 'model', 'context', 'trainer', 'orchestrator'].map((id) => [
      `/${id}`, async (_a, _ctx) => { called.push(id); return `${id} ok`; },
    ]),
  );
  for (const id of ['provider', 'model', 'context', 'trainer', 'orchestrator']) {
    const ctx = { openPicker: async () => id };
    const r = await runConfigSlash('', ctx, handlers);
    assert.equal(r, `${id} ok`);
    assert.ok(!ctx.requestSetup && !ctx.requestConfigStep, `${id} stays in-chat`);
  }
  assert.deepEqual(called, ['provider', 'model', 'context', 'trainer', 'orchestrator']);
});

test('/config picker: cancel stays in chat', async () => {
  const ctx = { openPicker: async () => null };
  const r = await runConfigSlash('', ctx, new Map());
  assert.match(String(r), /cancel/i);
  assert.ok(!ctx.requestSetup && !ctx.requestConfigStep);
});

test('every picker item routes somewhere (no dead rows)', () => {
  const inChat = new Set(['provider', 'model', 'context', 'trainer', 'orchestrator']);
  const exits = new Set(['channel', 'webhook', 'wizard']);
  for (const item of CONFIG_ITEMS) {
    assert.ok(inChat.has(item.id) || exits.has(item.id), `unrouted config item: ${item.id}`);
  }
});
