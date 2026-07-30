// tui/slash_gateway.mjs — `/gateway status|start|stop|port` for the chat REPL.
//
// `lazyclaw gateway` has always been a top-level CLI command, so the only way
// to check on it — or change the port it binds — was to leave the session.
// This exposes those operations in-chat. Everything external (pidfile probe,
// health fetch, child spawn, port-listening check) is injectable so the
// handler unit-tests without a real port or process.
//
// Contract: never throws. Every failure path returns a readable string, which
// the REPL appends to scrollback like any other slash result.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gatewayStatus, gatewayStop, _gatewayPidfilePath,
  GATEWAY_CHANNELS, PLUGIN_CHANNELS,
} from '../commands/gateway.mjs';
import { resolvePort, configuredPort, isValidPort } from '../lib/ports.mjs';

const SUBCOMMANDS = ['status', 'start', 'stop', 'port'];
// How long `/gateway start` waits for the child to record its pidfile before
// giving up. The spawn itself is fire-and-forget; this only bounds the report.
const START_TIMEOUT_MS = 6000;
const START_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 1500;

function _cliEntrypoint() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
}

function _readToken(cfgDir) {
  try {
    return fs.readFileSync(path.join(cfgDir, 'gateway.token'), 'utf8').trim() || null;
  } catch { return null; }
}

// Which channels the config says the gateway would run. Mirrors
// _selectChannels' "enabled unless explicitly disabled" rule without importing
// the flags path — this is a report, not a launch decision.
function _enabledChannels(cfg) {
  const configured = (cfg && cfg.channels && typeof cfg.channels === 'object') ? cfg.channels : {};
  const runnable = [...GATEWAY_CHANNELS, ...PLUGIN_CHANNELS];
  return runnable.filter((n) => configured[n] && configured[n].enabled !== false);
}

async function _probeHealth(port, token, doFetch) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  try {
    const res = await doFetch(`http://127.0.0.1:${port}/health`, {
      headers,
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (res.ok) return 'healthy';
    if (res.status === 401) return 'listening (auth token mismatch — re-read gateway.token)';
    return `listening (HTTP ${res.status})`;
  } catch {
    return 'unreachable (process alive but not answering /health)';
  }
}

async function _status(cfgDir, cfg, d) {
  const st = d.status({ configDir: cfgDir });
  if (!st.running) {
    return [
      'gateway: not running',
      `  pidfile: ${_gatewayPidfilePath(cfgDir)}`,
      '  start it with /gateway start',
    ].join('\n');
  }
  const token = d.readToken(cfgDir);
  const health = await _probeHealth(st.port, token, d.fetch);
  const channels = _enabledChannels(cfg);
  const configuredGatewayPort = resolvePort('gateway', {}, cfg);
  const portSource = configuredPort('gateway', cfg) != null ? 'config' : 'default';
  return [
    'gateway: running',
    `  pid:      ${st.pid}`,
    `  url:      http://127.0.0.1:${st.port}`,
    `  port cfg: ${configuredGatewayPort} (from ${portSource}) — /gateway port to change`,
    `  health:   ${health}`,
    `  auth:     ${token ? 'token present (gateway.token)' : 'no token file — open loopback'}`,
    `  channels: ${channels.length ? channels.join(' · ') : '(none enabled — daemon core only)'}`,
  ].join('\n');
}

// The gateway logs progress lines to stderr before it fails, so take the last
// non-empty line rather than the first — the failure is what it exits on. The
// `[gateway]` progress prefix and the pairing/auth warnings are noise here.
function _firstMeaningfulLine(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('[gateway]'));
  return lines.length ? lines[lines.length - 1] : '';
}

function _portInUse(reason) {
  return /EADDRINUSE|address already in use/i.test(String(reason || ''));
}

// Cheap liveness probe for `/gateway port <N>`'s validation: is some OTHER
// process already listening on the port the user wants to move the gateway
// to? A raw TCP connect (not a health fetch — the occupant need not be a
// lazyclaw process) with a short timeout, mirroring tui/slash_dashboard.mjs's
// _portIsListening. Injectable via deps so tests never touch a real socket.
function _isPortListening(port, timeoutMs = 200) {
  return new Promise((resolve) => {
    import('node:net').then(({ createConnection }) => {
      let settled = false;
      const sock = createConnection({ host: '127.0.0.1', port });
      const done = (ok) => {
        if (settled) return;
        settled = true;
        try { sock.destroy(); } catch { /* ignore */ }
        resolve(ok);
      };
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
      setTimeout(() => done(false), timeoutMs);
    }).catch(() => resolve(false));
  });
}

async function _start(cfgDir, cfg, d, overridePort) {
  const before = d.status({ configDir: cfgDir });
  if (before.running) {
    return `gateway: already running (pid ${before.pid}, http://127.0.0.1:${before.port})`;
  }
  // The port this attempt is actually aiming at — the one-off override if
  // given, else whatever config/default resolves to — used only to make the
  // EADDRINUSE hint below name the real collision, not a stale literal.
  const effectivePort = overridePort != null ? overridePort : resolvePort('gateway', {}, cfg);
  // Keep the child detached (it must outlive this chat session) but PIPE its
  // stderr rather than discarding it. A gateway that cannot start says why in
  // one line and exits — port already in use, unattended-safety guard, missing
  // channel creds — and with stdio:'ignore' that reason was lost, leaving only
  // a generic timeout that told the user to go re-run the command themselves.
  let child;
  try {
    // --port is a one-off override for THIS run only — it is never persisted.
    // Use `/gateway port <N>` to change the value future starts pick up.
    const argv = [_cliEntrypoint(), 'gateway'];
    if (overridePort != null) argv.push('--port', String(overridePort));
    child = d.spawn(process.execPath, argv, {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (err) {
    return `gateway: could not spawn — ${err?.message || err}`;
  }
  let errText = '';
  let exited = null;
  try {
    child.stderr?.on('data', (chunk) => { errText += String(chunk); });
    child.on?.('exit', (code, signal) => { exited = { code, signal }; });
  } catch { /* a stub without streams/events still works, just without detail */ }
  child.unref?.();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await d.sleep(START_POLL_MS);
    const st = d.status({ configDir: cfgDir });
    if (st.running) {
      return `gateway: started (pid ${st.pid}, http://127.0.0.1:${st.port}) — /gateway status for detail`;
    }
    // The child died before binding — report its own reason now instead of
    // waiting out the rest of the timeout.
    if (exited) break;
  }
  const reason = _firstMeaningfulLine(errText);
  if (reason) {
    return [
      `gateway: failed to start — ${reason}`,
      ...(_portInUse(reason) ? [
        `  Something else holds that port. \`lazyclaw daemon status\` and \`lsof -nP -iTCP:${effectivePort} -sTCP:LISTEN\` will name it,`,
        '  or move the gateway with `/gateway port <N>` (persists), or one-off it with `/gateway start --port <N>`.',
      ] : []),
    ].join('\n');
  }
  return [
    `gateway: spawned but did not come up within ${Math.round(START_TIMEOUT_MS / 1000)}s${exited ? ` (it exited${exited.code != null ? ` with code ${exited.code}` : ''} without explaining why)` : ''}.`,
    '  Run `lazyclaw gateway` in a terminal to see why (config guard, port in use, channel creds).',
  ].join('\n');
}

function _stop(cfgDir, d) {
  const res = d.stop({ configDir: cfgDir });
  if (!res.running) return 'gateway: not running (nothing to stop)';
  return `gateway: stopped (pid ${res.pid})`;
}

// `/gateway port [N]` — no argument reports the effective port + where it
// comes from; an argument validates + persists it to cfg.gateway.port via the
// ctx read/write seam (mirroring tui/hud.mjs's hudSlash) and reports old ->
// new. A running gateway keeps its already-bound port until restarted.
async function _setPort(ctx, valueRaw, d) {
  const value = String(valueRaw || '').trim();
  const cfg = ctx.readConfig ? ctx.readConfig() : (ctx.cfg || {});
  if (!value) {
    const effective = resolvePort('gateway', {}, cfg);
    const source = configuredPort('gateway', cfg) != null ? 'config' : 'default';
    return `gateway port: ${effective} (from ${source})`;
  }
  const n = Number(value);
  if (!isValidPort(n)) {
    return `/gateway port: invalid port "${value}" — must be an integer between 1024 and 65535`;
  }
  if (await d.isPortListening(n)) {
    return `/gateway port: ${n} is already in use by another process — free it first or pick a different port`;
  }
  const oldPort = resolvePort('gateway', {}, cfg);
  cfg.gateway = (cfg.gateway && typeof cfg.gateway === 'object') ? cfg.gateway : {};
  cfg.gateway.port = n;
  if (ctx.writeConfig) ctx.writeConfig(cfg);
  if (ctx.cfg) ctx.cfg.gateway = cfg.gateway; // mirror so a live getStatus sees the change
  return [
    `gateway port: ${oldPort} → ${n}`,
    '  a running gateway must be restarted (`/gateway stop` then `/gateway start`) to pick this up.',
  ].join('\n');
}

export async function gatewaySlash(args, ctx = {}, deps = {}) {
  const d = {
    status: deps.status || gatewayStatus,
    stop: deps.stop || gatewayStop,
    readToken: deps.readToken || _readToken,
    fetch: deps.fetch || ((...a) => fetch(...a)),
    sleep: deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    spawn: deps.spawn || null,
    isPortListening: deps.isPortListening || _isPortListening,
  };
  const cfgDir = ctx.cfgDir || '.';
  const cfg = ctx.cfg || {};
  const tokens = String(args || '').trim().split(/\s+/).filter(Boolean);
  const sub = (tokens[0] || 'status').toLowerCase();
  try {
    if (sub === 'status') return await _status(cfgDir, cfg, d);
    if (sub === 'stop') return _stop(cfgDir, d);
    if (sub === 'port') return await _setPort(ctx, tokens.slice(1).join(' '), d);
    if (sub === 'start') {
      if (!d.spawn) {
        const { spawn } = await import('node:child_process');
        d.spawn = spawn;
      }
      const pi = tokens.indexOf('--port');
      const overridePort = pi >= 0 && tokens[pi + 1] !== undefined ? tokens[pi + 1] : null;
      return await _start(cfgDir, cfg, d, overridePort);
    }
  } catch (err) {
    return `gateway: ${err?.message || err}`;
  }
  return `gateway: unknown subcommand "${sub}" — try ${SUBCOMMANDS.map((s) => `/gateway ${s}`).join(' · ')}`;
}
