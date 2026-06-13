// commands/gateway.mjs — `lazyclaw gateway`: the single-process always-on
// agent (Phase 5, "approach B").
//
// One process owns everything: it starts the HTTP daemon in-process (the
// session-bearing core) AND the configured channel transports (Slack Socket
// Mode / Telegram long-poll / Matrix /sync), feeding every inbound through
// the same POST /inbound the standalone listeners use — so the bridge
// contract, pairing gate, dedup, cost cap, and learning hook are identical.
// Because the channels live in-process, each registers a live sender into
// ctx.channelSenders, which finally gives POST /handoff a notifier: the
// target channel receives a resume marker and a failed notify rolls the
// binding back (channels/handoff.mjs). `slack|telegram|matrix listen` remain
// supported as standalone single-channel forwarders.
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { configPath, readConfig, writeConfig, readVersionFromRepo } from '../lib/config.mjs';
import { ensureRegistry } from '../lib/registry_boot.mjs';
import { loadDotenvIfAny } from '../dotenv_min.mjs';
import { assertUnattendedSafe, installCrashHandlers } from '../lib/gateway_guard.mjs';
import { makeInboundHandler } from '../lib/inbound_client.mjs';

export const GATEWAY_CHANNELS = ['slack', 'telegram', 'matrix'];

// In-tree plugin channels (channels-<name>/index.mjs). These are NOT builtins:
// each ships as a @lazyclaw/channel-* package that exports
// register({ addChannel }) and wires a factory returning a channels/base.mjs
// Channel (start/send/stop). The gateway loads the ENABLED ones at runtime so
// `channels enable discord` is actually reachable instead of a no-op.
export const PLUGIN_CHANNELS = ['discord', 'email', 'signal', 'voice', 'whatsapp'];

// Default per-channel constructors. Each receives { handler, logger,
// allowlist }, must return a started channel exposing send()/stop().
// Injectable so tests can run the full gateway with stub transports.
const DEFAULT_FACTORIES = {
  async slack({ handler, logger }) {
    const { SlackChannel } = await import('../channels/slack.mjs');
    const ch = new SlackChannel();
    await ch.start(handler);
    await ch._connectSocketMode({ logger });
    return ch;
  },
  async telegram({ handler, logger, allowlist }) {
    const { TelegramChannel } = await import('../channels/telegram.mjs');
    const ch = new TelegramChannel({ allowlist });
    await ch.start(handler, { poll: true, logger });
    return ch;
  },
  async matrix({ handler, logger, allowlist }) {
    const { MatrixChannel } = await import('../channels/matrix.mjs');
    const ch = new MatrixChannel({ allowlist });
    await ch.start(handler, { poll: true, logger });
    return ch;
  },
};

// Resolve an enabled plugin channel into the same gateway transport factory
// shape the builtins use: ({ handler, logger, allowlist }) -> a STARTED
// channel exposing send()/stop(). Dynamically imports channels-<name>/index.mjs
// and runs its register({ addChannel }) hook to capture the channel factory.
//
// A plugin that does not conform — import fails, no register export, never
// registers the requested name — is SKIPPED (returns null) so the gateway can
// log a warning and keep the other channels running. A factory that hands back
// the wrong shape is caught lazily, when the returned transport factory is
// invoked, so runGateway's per-channel try/catch turns it into a skip+warn.
// `importer` is injectable for tests.
export async function _loadPluginChannel(name, { importer } = {}) {
  const load = importer || ((n) => import(`../channels-${n}/index.mjs`));
  let mod;
  try {
    mod = await load(name);
  } catch {
    return null; // missing optional dep / module: skip, do not crash the gateway.
  }
  if (!mod || typeof mod.register !== 'function') return null;
  let channelFactory = null;
  try {
    mod.register({ addChannel: (n, factory) => { if (n === name) channelFactory = factory; } });
  } catch {
    return null;
  }
  if (typeof channelFactory !== 'function') return null;
  return async ({ handler, logger, allowlist }) => {
    const ch = channelFactory({ allowlist });
    if (!ch || typeof ch.start !== 'function' || typeof ch.send !== 'function' || typeof ch.stop !== 'function') {
      throw new Error(`plugin channel "${name}" does not conform to the channel interface (start/send/stop)`);
    }
    await ch.start(handler, { poll: true, logger });
    return ch;
  };
}

// Which channels should the gateway run? --channels a,b wins; otherwise the
// enabled cfg.channels sections we can actually run — a built-in transport OR
// an in-tree plugin channel.
export function _selectChannels(cfg, flags = {}) {
  const runnable = (n) => GATEWAY_CHANNELS.includes(n) || PLUGIN_CHANNELS.includes(n);
  if (flags.channels) {
    return String(flags.channels).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      .filter(runnable);
  }
  const configured = (cfg.channels && typeof cfg.channels === 'object') ? cfg.channels : {};
  const isEnabled = (n) => configured[n] && configured[n].enabled !== false;
  // Builtins first (in their canonical order, preserving existing behavior),
  // then enabled plugin channels.
  return [
    ...GATEWAY_CHANNELS.filter(isEnabled),
    ...PLUGIN_CHANNELS.filter(isEnabled),
  ];
}

// The whole gateway, with injectable deps so tests can drive it end-to-end
// (stub transports, ephemeral port) without Slack/Telegram/Matrix creds.
// Throws GatewayGuardError on an unsafe config. Returns { port, channels,
// channelSenders, skipped, stop }.
export async function runGateway(flags = {}, deps = {}) {
  await ensureRegistry();
  const log = deps.log || ((s) => process.stderr.write(s));
  const cfg = deps.readConfig ? deps.readConfig() : readConfig();
  assertUnattendedSafe(cfg, { surface: 'gateway' });
  const cfgDir = path.dirname(configPath());
  loadDotenvIfAny(cfgDir);

  // The gateway is session-bearing AND sits on a well-known always-on port,
  // so unlike the ad-hoc daemon it does not run unauthenticated by default:
  // resolve --auth-token > env > the persisted gateway.token, else mint one
  // and persist it 0600 (so `service install gateway` restarts keep the same
  // token and the operator can read it from the file — it is never logged).
  // --no-auth opts back into the historical open-loopback posture.
  let authToken = flags['auth-token'] || process.env.LAZYCLAW_AUTH_TOKEN || null;
  const tokenFile = path.join(cfgDir, 'gateway.token');
  if (!authToken && !flags['no-auth']) {
    try { authToken = fs.readFileSync(tokenFile, 'utf8').trim() || null; } catch { /* not minted yet */ }
    if (!authToken) {
      authToken = randomBytes(24).toString('hex');
      fs.writeFileSync(tokenFile, authToken + '\n', { mode: 0o600 });
    }
    log(`[gateway] auth token active (read it from ${tokenFile}; external callers need Authorization: Bearer)\n`);
  }
  if (!authToken) log('[gateway] warning: --no-auth — any local process can drive the agent on this port.\n');
  const allowlistArr = (cfg.pairing || []).map((p) => String(p.id));
  if (allowlistArr.length === 0) {
    log('[gateway] warning: pairing allowlist is empty — the agent will answer ANYONE who can reach a connected channel. Pair senders with `lazyclaw pairing add <id>`.\n');
  }

  // Live sender map: channels register here as they come up; the daemon's
  // handoff route reads it per-request (live Map, registrations visible).
  const channelSenders = new Map();

  const sessionsMod = await import('../sessions.mjs');
  const { startDaemon } = await import('../daemon.mjs');
  const startDaemonImpl = deps.startDaemonImpl || startDaemon;
  const d = await startDaemonImpl({
    port: flags.port !== undefined ? parseInt(flags.port, 10) : 19600,
    once: false,
    readConfig,
    writeConfig: authToken ? writeConfig : undefined,
    sessionsDirGetter: () => cfgDir,
    sessionsMod,
    version: () => readVersionFromRepo(),
    authToken: authToken || undefined,
    allowedOrigins: [],
    logger: deps.logger || null,
    channelSenders,
  });
  log(`[gateway] daemon core on http://127.0.0.1:${d.port}\n`);

  const daemonUrl = `http://127.0.0.1:${d.port}`;
  const factories = { ...DEFAULT_FACTORIES, ...(deps.channelFactories || {}) };
  const wanted = _selectChannels(cfg, flags);
  if (wanted.length === 0) {
    log('[gateway] no channels configured/enabled — running the daemon core only. Add one with `lazyclaw setup` or pass --channels slack,telegram,matrix.\n');
  }

  const channels = [];
  const skipped = [];
  for (const name of wanted) {
    const handler = makeInboundHandler({
      channel: name, daemonUrl, daemonToken: authToken,
      provider: flags.provider, model: flags.model,
    });
    try {
      // Builtin transport, else resolve an enabled in-tree plugin channel and
      // adapt it to the same factory shape. A plugin that won't load is skipped
      // (factory === null) rather than crashing the gateway.
      let factory = factories[name];
      if (!factory) {
        factory = await _loadPluginChannel(name, { importer: deps.pluginImporter });
        if (!factory) {
          skipped.push({ name, error: 'plugin channel did not conform (no usable register/factory)' });
          log(`[gateway] ${name}: skipped (plugin channel did not load or does not conform)\n`);
          continue;
        }
      }
      const ch = await factory({
        handler,
        logger: (line) => log(line),
        allowlist: allowlistArr.length ? allowlistArr : null,
      });
      channels.push({ name, ch });
      channelSenders.set(name, (externalId, text) => ch.send(externalId, text));
      log(`[gateway] ${name}: connected\n`);
    } catch (err) {
      // One channel missing creds must not take down the others.
      skipped.push({ name, error: err?.message || String(err) });
      log(`[gateway] ${name}: skipped (${err?.message || err})\n`);
    }
  }

  const stop = async () => {
    for (const { name, ch } of channels) {
      try { await ch.stop(); } catch { /* best-effort drain */ }
      channelSenders.delete(name);
    }
    // A wedged in-flight request must not hang shutdown forever — the crash
    // handler awaits stop() before exiting, and a hang there would leave a
    // crashed gateway alive-but-dead with no service-manager restart.
    await Promise.race([
      d.close(),
      new Promise((r) => setTimeout(r, 8_000)),
    ]);
  };

  return { port: d.port, channels, channelSenders, skipped, stop, authToken };
}

export async function cmdGateway(flags = {}) {
  let gw;
  try {
    gw = await runGateway(flags);
  } catch (err) {
    console.error(`gateway: ${err?.message || err}`);
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    url: `http://127.0.0.1:${gw.port}`,
    port: gw.port,
    channels: gw.channels.map((c) => c.name),
    skipped: gw.skipped,
  }) + '\n');
  process.stderr.write('[gateway] running. Ctrl-C to stop.\n');

  installCrashHandlers({ label: 'gateway', stop: () => gw.stop() });
  await new Promise((resolve) => {
    let shuttingDown = false;
    const onSig = async () => {
      if (shuttingDown) return process.exit(1);
      shuttingDown = true;
      process.stderr.write('\n[gateway] shutting down…\n');
      try { await gw.stop(); } catch { /* best-effort */ }
      resolve();
    };
    process.once('SIGINT', onSig);
    process.once('SIGTERM', onSig);
  });
}
