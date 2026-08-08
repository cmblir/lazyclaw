// tests/p4-channels-setup.test.mjs — /channels <name> setup collects credentials
// in-chat (via the masked modal prompt) and persists them to <cfgDir>/.env +
// cfg.channels, instead of redirecting to /config. The user's named pain.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
import { dispatchSlash } from '../tui/slash_dispatcher.mjs';

function tmpCfgDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-chsetup-'));
  process.env.POMPOS_CONFIG_DIR = d; // persistChannel's config write resolves this
  return d;
}
// Scripted openPicker: 'menu' kind returns the queued channel pick; 'text' kind
// (the masked field prompt) returns the queued freeText answer as {id,query}.
function scriptedCtx(cfgDir, { channel, answers }) {
  const q = [...answers];
  return {
    cfgDir, cfg: {},
    openPicker: async (opts) => {
      if (opts.kind === 'menu') return channel; // pick the channel
      const v = q.shift();                       // a field answer
      return v === null ? null : { id: '__text__', query: v };
    },
  };
}

test('/channels slack setup writes token to .env and enables the channel', async () => {
  const cfgDir = tmpCfgDir();
  const ctx = scriptedCtx(cfgDir, { channel: 'slack', answers: ['xoxb-REAL-TOKEN', ''] }); // appToken optional → skip
  const out = await dispatchSlash('/channels', 'slack setup', ctx, () => {});
  const env = fs.readFileSync(path.join(cfgDir, '.env'), 'utf8');
  assert.match(env, /SLACK_BOT_TOKEN=xoxb-REAL-TOKEN/);
  assert.ok(!/SLACK_APP_TOKEN/.test(env), 'skipped optional appToken not written');
  const cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8'));
  assert.equal(cfg.channels.slack.enabled, true);
  assert.match(out, /Slack credentials saved/);
});

test('bare /channels setup opens a channel picker', async () => {
  const cfgDir = tmpCfgDir();
  const ctx = scriptedCtx(cfgDir, { channel: 'telegram', answers: ['123:ABC-bot-token'] });
  const out = await dispatchSlash('/channels', 'setup', ctx, () => {});
  const env = fs.readFileSync(path.join(cfgDir, '.env'), 'utf8');
  assert.match(env, /TELEGRAM_BOT_TOKEN=123:ABC-bot-token/);
  assert.match(out, /Telegram credentials saved/);
});

test('/channels setup cancel (Esc on a required field) writes nothing', async () => {
  const cfgDir = tmpCfgDir();
  const ctx = scriptedCtx(cfgDir, { channel: 'telegram', answers: [null] }); // Esc the required token
  const out = await dispatchSlash('/channels', 'telegram setup', ctx, () => {});
  assert.match(out, /cancelled/);
  assert.ok(!fs.existsSync(path.join(cfgDir, '.env')));
});

test('/channels setup with no modal falls back to the config channel step', async () => {
  const cfgDir = tmpCfgDir();
  const ctx = { cfgDir, cfg: {} }; // no openPicker
  const out = await dispatchSlash('/channels', 'slack setup', ctx, () => {});
  assert.equal(out, 'EXIT');
  assert.equal(ctx.requestConfigStep, 'channel');
});

test('/channels <name> on|off toggle still works', async () => {
  const cfgDir = tmpCfgDir();
  const ctx = { cfgDir, cfg: {} };
  const out = await dispatchSlash('/channels', 'slack on', ctx, () => {});
  assert.match(out, /channel slack → enabled/);
});
