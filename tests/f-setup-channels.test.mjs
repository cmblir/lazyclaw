import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeDotenvMerge, loadDotenvIfAny } from '../dotenv_min.mjs';
import {
  CHANNEL_CATALOG,
  buildChannelEntry,
  persistChannel,
  runChannelStep,
} from '../commands/setup_channels.mjs';
import { KNOWN_CHANNELS } from '../daemon/routes/ops.mjs';

function tmpCfgDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaw-setup-'));
}

// ── Task 1: writeDotenvMerge ────────────────────────────────────────────

test('writeDotenvMerge creates .env at 0600 with the given vars', () => {
  const dir = tmpCfgDir();
  const p = writeDotenvMerge(dir, { TELEGRAM_BOT_TOKEN: '123:abc' });
  assert.equal(p, path.join(dir, '.env'));
  const mode = fs.statSync(p).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  assert.match(fs.readFileSync(p, 'utf8'), /^TELEGRAM_BOT_TOKEN=123:abc$/m);
});

test('writeDotenvMerge preserves existing keys and overwrites only collisions', () => {
  const dir = tmpCfgDir();
  fs.writeFileSync(path.join(dir, '.env'), '# comment\nEXISTING=keep\nSLACK_BOT_TOKEN=old\n');
  writeDotenvMerge(dir, { SLACK_BOT_TOKEN: 'xoxb-new', DISCORD_BOT_TOKEN: 'd1' });
  const raw = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.match(raw, /^EXISTING=keep$/m, 'unrelated key preserved');
  assert.match(raw, /^SLACK_BOT_TOKEN=xoxb-new$/m, 'collision overwritten');
  assert.match(raw, /^DISCORD_BOT_TOKEN=d1$/m, 'new key appended');
  assert.doesNotMatch(raw, /SLACK_BOT_TOKEN=old/, 'old value gone');
});

test('writeDotenvMerge round-trips through loadDotenvIfAny', () => {
  const dir = tmpCfgDir();
  writeDotenvMerge(dir, { MATRIX_ACCESS_TOKEN: 'syt_xxx' });
  const before = process.env.MATRIX_ACCESS_TOKEN;
  delete process.env.MATRIX_ACCESS_TOKEN;
  const r = loadDotenvIfAny(dir);
  assert.equal(process.env.MATRIX_ACCESS_TOKEN, 'syt_xxx');
  assert.ok(r.loaded >= 1);
  if (before === undefined) delete process.env.MATRIX_ACCESS_TOKEN; else process.env.MATRIX_ACCESS_TOKEN = before;
});

// ── Task 2: catalog + buildChannelEntry (pure) ──────────────────────────

test('CHANNEL_CATALOG covers exactly the daemon KNOWN channel names', () => {
  // Couple the catalog to the daemon's real, exported source of truth so this
  // test fails on actual drift instead of matching a stale local copy.
  assert.deepEqual(
    [...CHANNEL_CATALOG.map(c => c.name)].sort(),
    [...KNOWN_CHANNELS].sort(),
  );
});

test('buildChannelEntry(slack) maps the token to SLACK_BOT_TOKEN, enables, no plugin', () => {
  const e = buildChannelEntry('slack', { token: 'xoxb-123' });
  assert.deepEqual(e.envVars, { SLACK_BOT_TOKEN: 'xoxb-123' });
  assert.deepEqual(e.channelConfig, { enabled: true });
  assert.equal(e.needsPlugin, null);
});

test('buildChannelEntry(telegram) uses TELEGRAM_BOT_TOKEN', () => {
  const e = buildChannelEntry('telegram', { token: '111:aaa' });
  assert.deepEqual(e.envVars, { TELEGRAM_BOT_TOKEN: '111:aaa' });
});

test('buildChannelEntry(matrix) collects homeserver + access token + user id', () => {
  const e = buildChannelEntry('matrix', { homeserver: 'https://matrix.org', token: 'syt_x', userId: '@a:matrix.org' });
  assert.deepEqual(e.envVars, {
    MATRIX_HOMESERVER: 'https://matrix.org',
    MATRIX_ACCESS_TOKEN: 'syt_x',
    MATRIX_USER_ID: '@a:matrix.org',
  });
});

test('buildChannelEntry(discord) reports the plugin package and uses DISCORD_BOT_TOKEN', () => {
  const e = buildChannelEntry('discord', { token: 'd1' });
  assert.deepEqual(e.envVars, { DISCORD_BOT_TOKEN: 'd1' });
  assert.equal(e.needsPlugin, '@lazyclaw/channel-discord');
});

test('buildChannelEntry(http) is bind-only — no env vars, still enabled', () => {
  const e = buildChannelEntry('http', {});
  assert.deepEqual(e.envVars, {});
  assert.deepEqual(e.channelConfig, { enabled: true });
});

test('buildChannelEntry(unknown) throws', () => {
  assert.throws(() => buildChannelEntry('nope', {}), /unknown channel/);
});

// ── Task 3: persistChannel integration (temp cfgDir) ────────────────────

test('persistChannel writes creds to .env and enables cfg.channels.<name>', () => {
  const dir = tmpCfgDir();
  const prevCfg = process.env.LAZYCLAW_CONFIG_DIR;
  process.env.LAZYCLAW_CONFIG_DIR = dir;
  try {
    persistChannel(dir, 'telegram', { token: '111:aaa' });
    const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    assert.match(env, /^TELEGRAM_BOT_TOKEN=111:aaa$/m);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(cfg.channels.telegram.enabled, true);
  } finally {
    if (prevCfg === undefined) delete process.env.LAZYCLAW_CONFIG_DIR; else process.env.LAZYCLAW_CONFIG_DIR = prevCfg;
  }
});

// ── Task 4: interactive runChannelStep ──────────────────────────────────

// A scripted prompt: returns queued answers in order; throws if it runs dry.
function scriptedPrompt(answers) {
  const q = [...answers];
  return async () => {
    if (!q.length) throw new Error('prompt ran dry');
    return q.shift();
  };
}
const noColors = { accent: s=>s, bold: s=>s, dim: s=>s, ok: s=>s, warn: s=>s };

test('runChannelStep: selecting telegram + token persists and reports success', async () => {
  const dir = tmpCfgDir();
  const prevCfg = process.env.LAZYCLAW_CONFIG_DIR;
  process.env.LAZYCLAW_CONFIG_DIR = dir;
  const out = [];
  try {
    const r = await runChannelStep({
      cfgDir: dir,
      prompt: scriptedPrompt(['telegram', '111:aaa']),
      colors: noColors,
      write: (s) => out.push(s),
    });
    assert.equal(r.skipped, false);
    assert.equal(r.channel, 'telegram');
    assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /TELEGRAM_BOT_TOKEN=111:aaa/);
    const rendered = out.join('');
    // The raw token must never be echoed.
    assert.ok(!rendered.includes('111:aaa'), 'token must be masked in output');
    // And the masked echo must actually be present — a deleted/weakened mask
    // would still pass the absence check above, so assert the masked form too.
    assert.match(rendered, /TELEGRAM_BOT_TOKEN = 111…aa/, 'masked token must be emitted');
  } finally {
    if (prevCfg === undefined) delete process.env.LAZYCLAW_CONFIG_DIR; else process.env.LAZYCLAW_CONFIG_DIR = prevCfg;
  }
});

test('runChannelStep: empty selection skips cleanly', async () => {
  const dir = tmpCfgDir();
  const r = await runChannelStep({ cfgDir: dir, prompt: scriptedPrompt(['']), colors: noColors, write: () => {} });
  assert.equal(r.skipped, true);
  assert.equal(fs.existsSync(path.join(dir, '.env')), false);
});

test('runChannelStep: a plugin channel reports the install command', async () => {
  const dir = tmpCfgDir();
  const prevCfg = process.env.LAZYCLAW_CONFIG_DIR;
  process.env.LAZYCLAW_CONFIG_DIR = dir;
  const out = [];
  try {
    const r = await runChannelStep({
      cfgDir: dir,
      prompt: scriptedPrompt(['discord', 'd1']),
      colors: noColors,
      write: (s) => out.push(s),
    });
    assert.equal(r.needsPlugin, '@lazyclaw/channel-discord');
    const rendered = out.join('');
    assert.match(rendered, /@lazyclaw\/channel-discord/);
    // The manual npm fallback must be a real, working command: `npm install
    // --prefix <cfgDir> <pkg>` (the exact equivalent of the loader's plain
    // `npm install` run with cwd: configDir). The broken `npm i -w <dir>` form
    // errors with "No workspaces found", so it must never be printed.
    assert.ok(
      rendered.includes(`npm install --prefix ${dir} @lazyclaw/channel-discord`),
      'must print the working npm install --prefix fallback',
    );
    assert.doesNotMatch(rendered, / -w /, 'must not print the broken npm -w workspace fallback');
  } finally {
    if (prevCfg === undefined) delete process.env.LAZYCLAW_CONFIG_DIR; else process.env.LAZYCLAW_CONFIG_DIR = prevCfg;
  }
});
