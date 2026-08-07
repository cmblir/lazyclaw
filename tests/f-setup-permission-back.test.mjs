import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function withTmpCfg(fn) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-permstep-'));
  const prev = process.env.LAZYCLAW_CONFIG_DIR;
  process.env.LAZYCLAW_CONFIG_DIR = d;
  return Promise.resolve(fn(d)).finally(() => {
    if (prev === undefined) delete process.env.LAZYCLAW_CONFIG_DIR; else process.env.LAZYCLAW_CONFIG_DIR = prev;
    fs.rmSync(d, { recursive: true, force: true });
  });
}

test('runPermissionStep returns BACK when the back-prompt reports Esc (no config write)', async () => {
  await withTmpCfg(async () => {
    const { runPermissionStep } = await import('../commands/setup_permission.mjs');
    const { writeConfig, readConfig } = await import('../lib/config.mjs');
    writeConfig({ provider: 'claude-cli' });
    const r = await runPermissionStep({
      cfg: { provider: 'claude-cli' },
      backPrompt: async () => ({ value: '', back: true }),
    });
    assert.equal(r, 'BACK');
    assert.equal(readConfig().chat, undefined, 'Esc must not write permissionMode');
  });
});

test('runPermissionStep applies the typed choice and returns NEXT', async () => {
  await withTmpCfg(async () => {
    const { runPermissionStep } = await import('../commands/setup_permission.mjs');
    const { writeConfig, readConfig } = await import('../lib/config.mjs');
    writeConfig({ provider: 'claude-cli' });
    const r = await runPermissionStep({
      cfg: { provider: 'claude-cli' },
      backPrompt: async () => ({ value: 'ask', back: false }),
    });
    assert.equal(r, 'NEXT');
    assert.equal(readConfig().chat.permissionMode, 'default');  // 'ask' → default mode
  });
});

test('runPermissionStep skips (NEXT) for a non-claude provider', async () => {
  await withTmpCfg(async () => {
    const { runPermissionStep } = await import('../commands/setup_permission.mjs');
    const r = await runPermissionStep({ cfg: { provider: 'openai' }, backPrompt: async () => ({ value: 'ask' }) });
    assert.equal(r, 'NEXT');
  });
});
