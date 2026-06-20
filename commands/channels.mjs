// Slack / Telegram / Matrix listener commands, extracted from cli.mjs (D3).
import path from 'node:path';
import { configPath, readConfig, writeConfig } from '../lib/config.mjs';
import { ensureRegistry } from '../lib/registry_boot.mjs';
import { loadDotenvIfAny as _loadDotenvShared } from '../dotenv_min.mjs';
import { channelStatusList, channelSetEnabled, KNOWN_CHANNELS } from '../config_features.mjs';
import { assertUnattendedSafe, installCrashHandlers } from '../lib/gateway_guard.mjs';
import { makeInboundHandler } from '../lib/inbound_client.mjs';

// Thin .env loader wrapper kept local so the module stays self-contained.
export function _loadDotenvIfAny(cfgDir) { return _loadDotenvShared(cfgDir); }

// Fail closed before opening a listener socket: refuse to expose a remote
// inbound surface while the global unattended-sensitive tool override is on.
function _bootGuard(cfg, surface) {
  try { assertUnattendedSafe(cfg, { surface }); }
  catch (e) { console.error(e.message); process.exit(2); }
}

// Resolve the daemon the listener forwards to. Defaults to the dashboard/
// daemon loopback port; override with --daemon-url or LAZYCLAW_DAEMON_URL.
const DEFAULT_DAEMON_URL = 'http://127.0.0.1:19600';
function _daemonTarget(flags) {
  return {
    daemonUrl: flags['daemon-url'] || process.env.LAZYCLAW_DAEMON_URL || DEFAULT_DAEMON_URL,
    daemonToken: flags['auth-token'] || process.env.LAZYCLAW_AUTH_TOKEN || null,
  };
}

export async function cmdSlack(sub, positional, flags = {}) {
  if (sub !== 'listen') {
    console.error('Usage: lazyclaw slack listen [--provider X] [--model Y]');
    process.exit(2);
  }
  await ensureRegistry();
  const cfg = readConfig();
  _bootGuard(cfg, 'slack');
  const cfgDir = path.dirname(configPath());

  const envInfo = _loadDotenvIfAny(cfgDir);
  process.stderr.write(`[slack] .env: ${envInfo.loaded} keys loaded from ${envInfo.path}\n`);

  const { daemonUrl, daemonToken } = _daemonTarget(flags);
  // Bridge every inbound through the daemon's session-bearing /inbound so
  // chat + dashboard + all channels share one session/memory (single agent).
  // Slack captures the sender id (event.user) and forwards it, so a configured
  // pairing allowlist gates Slack the same as telegram/matrix.
  const handler = makeInboundHandler({ channel: 'slack', daemonUrl, daemonToken, provider: flags.provider, model: flags.model });

  const { SlackChannel } = await import('../channels/slack.mjs');
  const ch = new SlackChannel();
  process.stderr.write(`[slack] bridging to daemon ${daemonUrl}${flags.provider ? ` (provider=${flags.provider})` : ''}\n`);
  try {
    await ch.start(handler);
    await ch._connectSocketMode({ logger: (line) => process.stderr.write(line) });
  } catch (err) {
    if (err?.code === 'SLACK_MISSING_ENV') {
      console.error(`slack: missing env vars: ${(err.missing || []).join(', ')}`);
      console.error(`hint: set SLACK_APP_TOKEN (xapp-…, Socket Mode) in ${path.join(cfgDir, '.env')}`);
    } else {
      console.error(`slack: ${err?.message || err}`);
    }
    process.exit(2);
  }
  process.stderr.write(`[slack] listening. Ctrl-C to stop.\n`);
  installCrashHandlers({ label: 'slack', stop: () => ch.stop() });

  await new Promise((resolve) => {
    const onSig = async () => {
      process.stderr.write(`\n[slack] shutting down…\n`);
      try { await ch.stop(); } catch { /* best-effort */ }
      resolve();
    };
    process.once('SIGINT', onSig);
    process.once('SIGTERM', onSig);
  });
}

// `lazyclaw telegram listen` — zero-install mobile control surface.
// Long-polls the Telegram Bot API (no public URL / webhook needed) and
// pipes each inbound message through the active provider, replying in
// the same chat. Mirrors `slack listen`. Access is gated by the existing
// `pairing` allowlist (Telegram numeric user ids); an empty allowlist
// means "reply to anyone who can reach the bot".
export async function cmdTelegram(sub, positional, flags = {}) {
  if (sub !== 'listen') {
    console.error('Usage: lazyclaw telegram listen [--provider X] [--model Y]\n  Long-polls the Telegram Bot API. Set TELEGRAM_BOT_TOKEN in ~/.lazyclaw/.env.\n  Restrict who can talk to it with `lazyclaw pairing add <telegram-user-id>`.');
    process.exit(2);
  }
  await ensureRegistry();
  const cfg = readConfig();
  _bootGuard(cfg, 'telegram');
  const cfgDir = path.dirname(configPath());

  const envInfo = _loadDotenvIfAny(cfgDir);
  process.stderr.write(`[telegram] .env: ${envInfo.loaded} keys loaded from ${envInfo.path}\n`);

  const { daemonUrl, daemonToken } = _daemonTarget(flags);
  const handler = makeInboundHandler({ channel: 'telegram', daemonUrl, daemonToken, provider: flags.provider, model: flags.model });

  // The pairing allowlist doubles as the Telegram sender allowlist (a
  // channel-level gate complementary to the daemon's /inbound pairing check).
  const allowlist = (cfg.pairing || []).map((p) => String(p.id));
  const { TelegramChannel } = await import('../channels/telegram.mjs');
  let ch;
  try {
    ch = new TelegramChannel({ allowlist: allowlist.length ? allowlist : null });
  } catch (err) {
    console.error(`telegram: ${err?.message || err}`);
    process.exit(2);
  }
  process.stderr.write(`[telegram] bridging to daemon ${daemonUrl} allowlist=${allowlist.length || 'open'}${flags.provider ? ` (provider=${flags.provider})` : ''}\n`);
  try {
    await ch.start(handler, { poll: true, logger: (line) => process.stderr.write(line) });
  } catch (err) {
    if (err?.code === 'TELEGRAM_MISSING_TOKEN') {
      console.error('telegram: TELEGRAM_BOT_TOKEN not set');
      console.error(`hint: add TELEGRAM_BOT_TOKEN=... to ${path.join(cfgDir, '.env')}`);
    } else {
      console.error(`telegram: ${err?.message || err}`);
    }
    process.exit(2);
  }
  process.stderr.write(`[telegram] listening. Ctrl-C to stop.\n`);
  installCrashHandlers({ label: 'telegram', stop: () => ch.stop() });

  await new Promise((resolve) => {
    const onSig = async () => {
      process.stderr.write(`\n[telegram] shutting down…\n`);
      try { await ch.stop(); } catch { /* best-effort */ }
      resolve();
    };
    process.once('SIGINT', onSig);
    process.once('SIGTERM', onSig);
  });
}

// `lazyclaw matrix listen` — Matrix inbound over the client-server API's
// long-poll /sync (no SDK). Mirrors `telegram listen`. Set MATRIX_HOMESERVER
// + MATRIX_ACCESS_TOKEN (+ MATRIX_USER_ID for self-filtering) in ~/.lazyclaw/.env.
export async function cmdMatrix(sub, positional, flags = {}) {
  if (sub !== 'listen') {
    console.error('Usage: lazyclaw matrix listen [--provider X] [--model Y]\n  Long-polls the Matrix /sync API. Set MATRIX_HOMESERVER + MATRIX_ACCESS_TOKEN (+ MATRIX_USER_ID) in ~/.lazyclaw/.env.\n  Restrict who can talk to it with `lazyclaw pairing add <@user:server>`.');
    process.exit(2);
  }
  await ensureRegistry();
  const cfg = readConfig();
  _bootGuard(cfg, 'matrix');
  const cfgDir = path.dirname(configPath());

  const envInfo = _loadDotenvIfAny(cfgDir);
  process.stderr.write(`[matrix] .env: ${envInfo.loaded} keys loaded from ${envInfo.path}\n`);

  const { daemonUrl, daemonToken } = _daemonTarget(flags);
  const handler = makeInboundHandler({ channel: 'matrix', daemonUrl, daemonToken, provider: flags.provider, model: flags.model });

  const allowlist = (cfg.pairing || []).map((p) => String(p.id));
  const { MatrixChannel } = await import('../channels/matrix.mjs');
  let ch;
  try {
    ch = new MatrixChannel({ allowlist: allowlist.length ? allowlist : null });
  } catch (err) {
    console.error(`matrix: ${err?.message || err}`);
    process.exit(2);
  }
  process.stderr.write(`[matrix] bridging to daemon ${daemonUrl} allowlist=${allowlist.length || 'open'}${flags.provider ? ` (provider=${flags.provider})` : ''}\n`);
  try {
    await ch.start(handler, { poll: true, logger: (line) => process.stderr.write(line) });
  } catch (err) {
    if (err?.code === 'MATRIX_MISSING_TOKEN' || err?.code === 'MATRIX_MISSING_HOMESERVER') {
      console.error(`matrix: ${err.message}`);
      console.error(`hint: set MATRIX_HOMESERVER and MATRIX_ACCESS_TOKEN in ${path.join(cfgDir, '.env')}`);
    } else {
      console.error(`matrix: ${err?.message || err}`);
    }
    process.exit(2);
  }
  process.stderr.write(`[matrix] listening. Ctrl-C to stop.\n`);
  installCrashHandlers({ label: 'matrix', stop: () => ch.stop() });

  await new Promise((resolve) => {
    const onSig = async () => {
      process.stderr.write(`\n[matrix] shutting down…\n`);
      try { await ch.stop(); } catch { /* best-effort */ }
      resolve();
    };
    process.once('SIGINT', onSig);
    process.once('SIGTERM', onSig);
  });
}

// `lazyclaw channels [list|enable <name>|disable <name>|install <pkg>|remove <pkg>]`
// list   — configured built-in channels (cfg.channels.<name>) + installed plugins.
// enable/disable — toggle cfg.channels.<name>.enabled (view/edit the setting).
// install/remove — manage @lazyclaw/channel-* plugin packages.
export async function cmdChannels(sub, positional = [], flags = {}) {
  const cfgDir = path.dirname(configPath());
  const { createLoader, listInstalled } = await import('../channels/loader.mjs');
  const loader = createLoader({ configDir: cfgDir });

  if (sub === 'install') {
    const name = positional[0];
    if (!name) { process.stderr.write('usage: lazyclaw channels install <name>   (e.g. discord, email, whatsapp)\n'); process.exit(2); }
    const { isPluginName } = await import('../channels/loader.mjs');
    // Back-compat: an explicit @lazyclaw/channel-* spec still routes through the
    // legacy plugin loader (for anyone shipping a real published package).
    if (isPluginName(name)) {
      const info = await loader.install(name);
      process.stdout.write(`installed ${info.name}@${info.version}\n`);
      return;
    }
    const { channelByName, channelReadiness } = await import('./setup_channels.mjs');
    const spec = channelByName(name.toLowerCase());
    if (!spec) { process.stderr.write(`unknown channel: ${name} (known: ${KNOWN_CHANNELS.join(', ')})\n`); process.exit(2); }
    if (spec.builtin) { process.stdout.write(`channel ${spec.name} is built in — no install needed.\n`); return; }
    if (spec.binary && (!spec.deps || !spec.deps.length)) {
      process.stderr.write(`channel ${spec.name} needs the external "${spec.binary}" binary on your PATH (not an npm package). Install it from its project, then: lazyclaw channels enable ${spec.name}\n`);
      process.exit(2);
    }
    const deps = spec.deps || [];
    if (!deps.length) { process.stdout.write(`channel ${spec.name} needs no runtime package — set creds with \`lazyclaw setup\`, then \`lazyclaw channels enable ${spec.name}\`.\n`); return; }
    // Install the in-tree adapter's runtime deps INTO the config dir; the
    // gateway resolves them from there (commands/gateway.mjs _loadPluginChannel).
    const { spawnSync } = await import('node:child_process');
    process.stdout.write(`installing ${deps.join(', ')} into ${cfgDir} …\n`);
    const res = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--prefix', cfgDir, ...deps], { stdio: 'inherit', env: process.env });
    if (res.status !== 0) { process.stderr.write(`npm install failed (exit ${res.status})\n`); process.exit(1); }
    const r = channelReadiness(spec.name, cfgDir);
    if (r.ready) {
      const cfg = readConfig();
      channelSetEnabled(cfg, spec.name, true);
      writeConfig(cfg);
      process.stdout.write(`installed ${deps.join(', ')} — channel ${spec.name} enabled.\n`);
    } else {
      process.stdout.write(`installed ${deps.join(', ')}. Still missing: ${[...r.missingDeps, r.missingBinary].filter(Boolean).join(', ')}.\n`);
    }
    return;
  }
  if (sub === 'remove' || sub === 'uninstall') {
    const name = positional[0];
    if (!name) { process.stderr.write('usage: lazyclaw channels remove <@lazyclaw/channel-name>\n'); process.exit(2); }
    await loader.remove(name);
    process.stdout.write(`removed ${name}\n`);
    return;
  }
  if (sub === 'test') {
    const name = (positional[0] || '').toLowerCase();
    if (!name) { process.stderr.write('usage: lazyclaw channels test <name>\n'); process.exit(2); }
    const { verifyChannel } = await import('./setup_channels.mjs');
    try { (await import('../dotenv_min.mjs')).loadDotenvIfAny(cfgDir); } catch { /* best-effort */ }
    const r = await verifyChannel(name);
    if (flags.json) { process.stdout.write(JSON.stringify({ channel: name, ...r }) + '\n'); return; }
    if (r.ok === true) process.stdout.write(`✓ ${name} verified — ${r.detail}\n`);
    else if (r.ok === null) process.stdout.write(`· ${name}: ${r.detail}\n`);
    else { process.stdout.write(`✗ ${name}: ${r.detail}${r.hint ? `\n  fix: ${r.hint}` : ''}\n`); process.exitCode = 1; }
    return;
  }
  if (sub === 'enable' || sub === 'disable') {
    const name = (positional[0] || '').toLowerCase();
    if (!name) { process.stderr.write(`usage: lazyclaw channels ${sub} <name>\n`); process.exit(2); }
    const cfg = readConfig();
    // Reject unknown names so a typo can't silently create a bogus
    // cfg.channels.<name> section that then leaks into the list view.
    // Stay permissive for pre-existing custom sections.
    const existing = (cfg.channels && typeof cfg.channels === 'object') ? cfg.channels : {};
    if (!KNOWN_CHANNELS.includes(name) && !(name in existing)) {
      process.stderr.write(`unknown channel: ${name} (known: ${KNOWN_CHANNELS.join(', ')})\n`);
      process.exit(2);
    }
    channelSetEnabled(cfg, name, sub === 'enable');
    writeConfig(cfg);
    process.stdout.write(JSON.stringify({ ok: true, channel: name, enabled: sub === 'enable' }) + '\n');
    return;
  }

  // list (default): configured built-in channels + installed plugins.
  const cfg = readConfig();
  const configured = channelStatusList(cfg);
  const plugins = listInstalled(cfgDir);
  if (flags.json) {
    process.stdout.write(JSON.stringify({ configured, plugins }, null, 2) + '\n');
    return;
  }
  process.stdout.write('configured channels:\n');
  if (configured.length === 0) {
    process.stdout.write('  (none — run `lazyclaw setup` or `/config` in chat to add one)\n');
  } else {
    for (const ch of configured) {
      const agent = ch.boundAgent ? ` · agent: ${ch.boundAgent}` : '';
      process.stdout.write(`  ${ch.name}\t${ch.enabled ? 'enabled' : 'disabled'}${agent}\n`);
    }
  }
  process.stdout.write(`plugins: ${plugins.length ? plugins.map((p) => `${p.name}@${p.version}`).join(', ') : '(none installed)'}\n`);
  process.stdout.write('\ntoggle: lazyclaw channels <enable|disable> <name>  ·  add creds: lazyclaw setup\n');
}


