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
  channelReadiness,
} from '../commands/setup_channels.mjs';
import { KNOWN_CHANNELS } from '../daemon/routes/ops.mjs';

function tmpCfgDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-setup-'));
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

test('writeDotenvMerge does not write a leading blank line into a fresh .env', () => {
  const dir = tmpCfgDir();
  writeDotenvMerge(dir, { SLACK_BOT_TOKEN: 'xoxb-1' });
  const raw = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.ok(!raw.startsWith('\n'), 'fresh .env must not begin with a blank line');
  assert.match(raw, /^SLACK_BOT_TOKEN=xoxb-1$/m);
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

test('loadDotenvIfAny falls back to the configured dir when called with no cfgDir', () => {
  // The /channels test slash path called loadDotenvIfAny(ctx.cfgDir) with an
  // undefined cfgDir → path.join(undefined,'.env') threw, was swallowed by a
  // try/catch, and the .env was silently never loaded → verifyChannel saw no
  // token and reported a false "no token set".
  const dir = tmpCfgDir();
  fs.writeFileSync(path.join(dir, '.env'), 'SLACK_BOT_TOKEN=xoxb-fallback\n');
  const prevDir = process.env.POMPOS_CONFIG_DIR;
  const prevTok = process.env.SLACK_BOT_TOKEN;
  process.env.POMPOS_CONFIG_DIR = dir;
  delete process.env.SLACK_BOT_TOKEN;
  try {
    const r = loadDotenvIfAny();
    assert.equal(process.env.SLACK_BOT_TOKEN, 'xoxb-fallback');
    assert.ok(r.loaded >= 1);
  } finally {
    if (prevDir === undefined) delete process.env.POMPOS_CONFIG_DIR; else process.env.POMPOS_CONFIG_DIR = prevDir;
    if (prevTok === undefined) delete process.env.SLACK_BOT_TOKEN; else process.env.SLACK_BOT_TOKEN = prevTok;
  }
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

test('buildChannelEntry(slack) maps the token to SLACK_BOT_TOKEN, builtin, no deps', () => {
  const e = buildChannelEntry('slack', { token: 'xoxb-123' });
  assert.deepEqual(e.envVars, { SLACK_BOT_TOKEN: 'xoxb-123' });
  assert.equal(e.builtin, true);
  assert.deepEqual(e.deps, []);
  assert.equal(e.binary, null);
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

test('buildChannelEntry(discord) reports the real runtime dep (not a 404 npm package) and uses DISCORD_BOT_TOKEN', () => {
  const e = buildChannelEntry('discord', { token: 'd1' });
  assert.deepEqual(e.envVars, { DISCORD_BOT_TOKEN: 'd1' });
  assert.equal(e.builtin, false);
  assert.deepEqual(e.deps, ['discord.js']);
});

test('CHANNEL_CATALOG no longer points at unpublished @cmblir/channel-* packages', () => {
  for (const c of CHANNEL_CATALOG) {
    assert.equal(c.plugin, undefined, `${c.name} must not carry a scoped plugin pointer`);
    if (!c.builtin) assert.ok(Array.isArray(c.deps) || c.binary, `${c.name} must declare a real dep or binary`);
  }
});

test('buildChannelEntry(http) is bind-only — no env vars, builtin', () => {
  const e = buildChannelEntry('http', {});
  assert.deepEqual(e.envVars, {});
  assert.equal(e.builtin, true);
  assert.deepEqual(e.deps, []);
});

test('buildChannelEntry(unknown) throws', () => {
  assert.throws(() => buildChannelEntry('nope', {}), /unknown channel/);
});

// ── Task 3: persistChannel integration (temp cfgDir) ────────────────────

test('persistChannel writes creds to .env and enables cfg.channels.<name>', () => {
  const dir = tmpCfgDir();
  const prevCfg = process.env.POMPOS_CONFIG_DIR;
  process.env.POMPOS_CONFIG_DIR = dir;
  try {
    persistChannel(dir, 'telegram', { token: '111:aaa' });
    const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    assert.match(env, /^TELEGRAM_BOT_TOKEN=111:aaa$/m);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(cfg.channels.telegram.enabled, true);
  } finally {
    if (prevCfg === undefined) delete process.env.POMPOS_CONFIG_DIR; else process.env.POMPOS_CONFIG_DIR = prevCfg;
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
// Offline fetch stub so credential-verification (verifyChannel) never touches
// the network in tests that aren't asserting the verify path.
const offlineFetch = async () => ({ ok: true, json: async () => ({ ok: false, description: 'offline-stub' }) });

// A scripted arrow-key picker: returns the queued item whose id matches the
// next queued channel name, then '__done__'. Drives runChannelStep's `pick`.
function scriptedPick(channelNames) {
  const q = [...channelNames, '__done__'];
  return async ({ items }) => {
    const want = q.shift();
    return items.find((it) => it.id === want) || items.find((it) => it.id === '__done__');
  };
}

test('runChannelStep: selecting telegram + token persists and reports success', async () => {
  const dir = tmpCfgDir();
  const prevCfg = process.env.POMPOS_CONFIG_DIR;
  process.env.POMPOS_CONFIG_DIR = dir;
  const out = [];
  try {
    const r = await runChannelStep({
      cfgDir: dir,
      pick: scriptedPick(['telegram']),
      prompt: scriptedPrompt(['111:aaa']),
      colors: noColors,
      write: (s) => out.push(s),
      fetchImpl: offlineFetch,
    });
    assert.equal(r.skipped, false);
    assert.deepEqual(r.channels, ['telegram']);
    assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /TELEGRAM_BOT_TOKEN=111:aaa/);
    const rendered = out.join('');
    // The raw token must never be echoed.
    assert.ok(!rendered.includes('111:aaa'), 'token must be masked in output');
    // And the masked echo must actually be present — a deleted/weakened mask
    // would still pass the absence check above, so assert the masked form too.
    assert.match(rendered, /TELEGRAM_BOT_TOKEN = 111…aa/, 'masked token must be emitted');
  } finally {
    if (prevCfg === undefined) delete process.env.POMPOS_CONFIG_DIR; else process.env.POMPOS_CONFIG_DIR = prevCfg;
  }
});

test('runChannelStep: verifies a builtin channel credential and reports ✓ on success', async () => {
  const dir = tmpCfgDir();
  const prevCfg = process.env.POMPOS_CONFIG_DIR;
  process.env.POMPOS_CONFIG_DIR = dir;
  const out = [];
  // Fake fetch: telegram getMe returns ok.
  const fetchImpl = async () => ({ json: async () => ({ ok: true, result: { username: 'mybot' } }) });
  try {
    await runChannelStep({
      cfgDir: dir,
      pick: scriptedPick(['telegram']),
      prompt: scriptedPrompt(['111:aaa']),
      colors: noColors,
      write: (s) => out.push(s),
      fetchImpl,
    });
    const rendered = out.join('');
    assert.match(rendered, /✓ verified/, 'a good token must report verified');
    assert.match(rendered, /mybot/, 'verify detail surfaces the bot identity');
  } finally {
    if (prevCfg === undefined) delete process.env.POMPOS_CONFIG_DIR; else process.env.POMPOS_CONFIG_DIR = prevCfg;
  }
});

test('runChannelStep: a rejected credential reports ✗ not verified during setup', async () => {
  const dir = tmpCfgDir();
  const prevCfg = process.env.POMPOS_CONFIG_DIR;
  process.env.POMPOS_CONFIG_DIR = dir;
  const out = [];
  const fetchImpl = async () => ({ json: async () => ({ ok: false, description: 'Unauthorized' }) });
  try {
    await runChannelStep({
      cfgDir: dir,
      pick: scriptedPick(['telegram']),
      prompt: scriptedPrompt(['bad-token']),
      colors: noColors,
      write: (s) => out.push(s),
      fetchImpl,
    });
    assert.match(out.join(''), /✗ not verified/, 'a bad token must be flagged at setup time');
  } finally {
    if (prevCfg === undefined) delete process.env.POMPOS_CONFIG_DIR; else process.env.POMPOS_CONFIG_DIR = prevCfg;
  }
});

test('runChannelStep: empty selection skips cleanly', async () => {
  const dir = tmpCfgDir();
  // pick immediately returns '__done__' (or Esc → 'BACK') → step skips.
  const r = await runChannelStep({ cfgDir: dir, pick: scriptedPick([]), prompt: scriptedPrompt([]), colors: noColors, write: () => {} });
  assert.equal(r.skipped, true);
  assert.equal(fs.existsSync(path.join(dir, '.env')), false);
});

test('runChannelStep: Esc on the picker skips cleanly', async () => {
  const dir = tmpCfgDir();
  const r = await runChannelStep({ cfgDir: dir, pick: async () => 'BACK', prompt: scriptedPrompt([]), colors: noColors, write: () => {} });
  assert.equal(r.skipped, true);
});

test('runChannelStep: configures multiple channels in one pass', async () => {
  const dir = tmpCfgDir();
  const prevCfg = process.env.POMPOS_CONFIG_DIR;
  process.env.POMPOS_CONFIG_DIR = dir;
  try {
    const r = await runChannelStep({
      cfgDir: dir,
      pick: scriptedPick(['telegram', 'slack']),
      // telegram: token ; slack: bot token + app token (optional)
      prompt: scriptedPrompt(['111:aaa', 'xoxb-tok', '']),
      colors: noColors,
      write: () => {},
      fetchImpl: offlineFetch,
    });
    assert.deepEqual(r.channels, ['telegram', 'slack']);
    const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    assert.match(env, /TELEGRAM_BOT_TOKEN=111:aaa/);
    assert.match(env, /SLACK_BOT_TOKEN=xoxb-tok/);
  } finally {
    if (prevCfg === undefined) delete process.env.POMPOS_CONFIG_DIR; else process.env.POMPOS_CONFIG_DIR = prevCfg;
  }
});

test('runChannelStep: an in-tree channel with a missing dep is saved DISABLED with an honest install hint (no 404 package)', async () => {
  const dir = tmpCfgDir();
  const prevCfg = process.env.POMPOS_CONFIG_DIR;
  process.env.POMPOS_CONFIG_DIR = dir;
  const out = [];
  try {
    const r = await runChannelStep({
      cfgDir: dir,
      pick: scriptedPick(['discord']),
      prompt: scriptedPrompt(['d1']),
      colors: noColors,
      write: (s) => out.push(s),
    });
    // discord.js is not installed in the temp cfgDir → not ready.
    assert.equal(r.needsPlugin, 'discord.js');
    const rendered = out.join('');
    // Never advertises the unpublished @cmblir/channel-* package.
    assert.doesNotMatch(rendered, /@[a-z-]+\/channel-/, 'must not point at a 404 npm package');
    // Points at the REAL runtime dep + the working install command.
    assert.match(rendered, /discord\.js/);
    assert.ok(rendered.includes('pompos channels install discord'), 'must print the real install command');
    assert.ok(rendered.includes(`npm install --prefix ${dir} discord.js`), 'must show the equivalent npm --prefix command');
    // And the channel is NOT enabled until the dep is present.
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(cfg.channels.discord.enabled, false, 'in-tree channel stays disabled until its dep is installed');
    assert.deepEqual(cfg.channels.discord.pending.deps, ['discord.js']);
  } finally {
    if (prevCfg === undefined) delete process.env.POMPOS_CONFIG_DIR; else process.env.POMPOS_CONFIG_DIR = prevCfg;
  }
});

test('channelReadiness: builtins are always ready; an in-tree channel with no installed dep is not', () => {
  const dir = tmpCfgDir();
  assert.equal(channelReadiness('slack', dir).ready, true);
  assert.equal(channelReadiness('http', dir).ready, true);
  const discord = channelReadiness('discord', dir);
  assert.equal(discord.ready, false);
  assert.deepEqual(discord.missingDeps, ['discord.js']);
  // voice declares no runtime package → ready once selected (creds only).
  assert.equal(channelReadiness('voice', dir).ready, true);
});
