// Daemon + dashboard lifecycle commands (cmdDashboard, cmdDaemon) plus the
// _killPortOccupant helper, extracted from cli.mjs in Phase D3.
import path from 'node:path';
import { ensureRegistry } from '../lib/registry_boot.mjs';
import { configPath, readConfig, writeConfig, readVersionFromRepo } from '../lib/config.mjs';
import { assertUnattendedSafe, installCrashHandlers } from '../lib/gateway_guard.mjs';

// Fail closed before binding the HTTP surface: the daemon/dashboard serve
// POST /inbound + /agent, so the global unattended-sensitive override must
// not be on while they are exposed.
function _bootGuard(surface) {
  try { assertUnattendedSafe(readConfig(), { surface }); }
  catch (e) { console.error(e.message); process.exit(2); }
}

export async function _killPortOccupant(port) {
  if (process.platform === 'win32') return false;
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    let lsof;
    try {
      lsof = spawn('lsof', ['-ti', `tcp:${port}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (_) { return resolve(false); }
    let buf = '';
    lsof.stdout.on('data', (d) => { buf += d.toString('utf8'); });
    lsof.on('error', () => resolve(false));
    lsof.on('close', () => {
      const pids = buf.trim().split(/\s+/).map((s) => parseInt(s, 10)).filter(Number.isFinite);
      if (!pids.length) return resolve(false);
      // SIGTERM first so node has a chance to clean up; SIGKILL the
      // holdouts after a short grace window.
      for (const pid of pids) {
        try { process.kill(pid, 'SIGTERM'); } catch (_) { /* gone already */ }
      }
      setTimeout(() => {
        for (const pid of pids) {
          try { process.kill(pid, 'SIGKILL'); } catch (_) { /* gone */ }
        }
        resolve(true);
      }, 200);
    });
  });
}

export async function cmdDashboard(flags = {}) {
  await ensureRegistry();
  _bootGuard('dashboard');
  const sessionsMod = await import('../sessions.mjs');
  const { startDaemon } = await import('../daemon.mjs');
  const port = flags.port !== undefined ? parseInt(flags.port, 10) : 19600;
  const cfgDir = path.dirname(configPath());
  const daemonOpts = {
    port,
    once: false,
    readConfig,
    writeConfig,
    sessionsDirGetter: () => cfgDir,
    sessionsMod,
    version: () => readVersionFromRepo(),
    workflowStateDir: () => process.env.LAZYCLAW_WORKFLOW_STATE_DIR || '.workflow-state',
    // No auth token by default — same loopback-only assumption the
    // bare daemon uses. Users who want to expose the dashboard set
    // LAZYCLAW_AUTH_TOKEN + --allow-origin via the daemon command.
    authToken: undefined,
    allowedOrigins: [],
    // The dashboard's browser tab posts back to the same loopback URL
    // it was served from (e.g. `http://127.0.0.1:19600`). Without this
    // opt-in every chat send / mutation tripped the daemon's CSRF gate
    // with `403 forbidden origin`. Safe — the daemon binds 127.0.0.1
    // only, so an attacker can't reach it with a loopback origin
    // unless they're already on the machine.
    allowLoopbackOrigin: true,
    rateLimit: null,
    responseCache: null,
    logger: null,
    costCap: null,
  };
  let d;
  try {
    d = await startDaemon(daemonOpts);
  } catch (err) {
    if (err?.code !== 'EADDRINUSE') throw err;
    // Port is held by a leftover dashboard / daemon. Try to free it
    // (lsof + kill on macOS/Linux); on failure, fall back to a random
    // port so the user always gets a working dashboard rather than a
    // crash trace.
    const portInUse = port;
    process.stderr.write(`  ⚠ port ${portInUse} is in use — likely a previous dashboard didn't shut down.\n`);
    const killed = await _killPortOccupant(portInUse);
    if (killed) {
      process.stderr.write(`  ✓ freed port ${portInUse} (killed prior listener) — retrying…\n`);
      // Short pause so the OS releases the port before we re-listen.
      await new Promise(r => setTimeout(r, 250));
      try { d = await startDaemon(daemonOpts); }
      catch (err2) {
        if (err2?.code !== 'EADDRINUSE') throw err2;
        process.stderr.write(`  ⚠ still in use — falling back to a random port.\n`);
        d = await startDaemon({ ...daemonOpts, port: 0 });
      }
    } else {
      process.stderr.write(`  ⚠ couldn't free port ${portInUse} automatically — falling back to a random port.\n`);
      d = await startDaemon({ ...daemonOpts, port: 0 });
    }
  }
  const url = `http://127.0.0.1:${d.port}/dashboard`;
  process.stdout.write(`🦞 LazyClaw dashboard listening at ${url}\n`);
  if (!flags['no-open']) {
    // macOS uses `open`; Linux generally `xdg-open`; Windows
    // `cmd /c start`. Detect by platform; bail silently if the
    // helper fails — the URL is already on stdout for fallback.
    const { spawn } = await import('node:child_process');
    let cmd, args;
    if (process.platform === 'darwin')      { cmd = 'open';      args = [url]; }
    else if (process.platform === 'win32')  { cmd = 'cmd';       args = ['/c', 'start', '""', url]; }
    else                                    { cmd = 'xdg-open';  args = [url]; }
    try {
      spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
    } catch (_) { /* user can click the URL above */ }
  }
  // Forward SIGINT/SIGTERM to a graceful shutdown so Ctrl-C doesn't
  // strand a port-bound server. Same shape cmdDaemon uses.
  const { gracefulShutdown } = await import('../daemon.mjs');
  installCrashHandlers({ label: 'dashboard', stop: () => gracefulShutdown(d.server, 5_000) });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return process.exit(1);
    shuttingDown = true;
    process.stdout.write('\n  shutting down…\n');
    const result = await gracefulShutdown(d.server, 5_000);
    process.exit(result.forced ? 1 : 0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export async function cmdDaemon(flags) {
  await ensureRegistry();
  _bootGuard('daemon');
  const sessionsMod = await import('../sessions.mjs');
  const { startDaemon } = await import('../daemon.mjs');
  const port = flags.port !== undefined ? parseInt(flags.port, 10) : 0;
  const once = !!flags.once;
  // --auth-token wins over the env var so a per-invocation override works.
  // When neither is set, the daemon runs unauthenticated (the historical
  // single-user-loopback default).
  const authToken = flags['auth-token'] || process.env.LAZYCLAW_AUTH_TOKEN || null;
  // --allow-origin accepts a comma-separated list (also reads
  // LAZYCLAW_ALLOW_ORIGINS env). When neither is set, any request that
  // carries an `Origin` header is rejected with 403 — the browser-CSRF
  // / DNS-rebinding default. CLI/script callers don't send Origin so
  // they're unaffected.
  const originSrc = flags['allow-origin'] || process.env.LAZYCLAW_ALLOW_ORIGINS || '';
  const allowedOrigins = String(originSrc).split(',').map(s => s.trim()).filter(Boolean);
  // --rate-limit <capacity> sets a token-bucket cap per remote IP.
  // refillPerSec defaults to capacity/60 so the bucket sustains the
  // same long-run rate (a bucket of 60 / 1 per second == 60 req/min).
  // Pass 0 (or omit) to leave the daemon unlimited.
  const rlCap = flags['rate-limit'] ? parseInt(flags['rate-limit'], 10) : 0;
  const rateLimit = (Number.isFinite(rlCap) && rlCap > 0)
    ? { capacity: rlCap, refillPerSec: rlCap / 60 }
    : null;
  // --response-cache flips the daemon-scope cache on (no value form ⇒ true).
  // Per-request opt-in still happens via body.cache; this just allocates
  // the shared map so the cache state actually persists.
  const responseCache = flags['response-cache'] ? true : null;
  // --log <level> enables structured access logging. Also reads
  // LAZYCLAW_LOG_LEVEL. When set, every request emits a JSON line on
  // stderr at info level: {ts, level, msg:'access', method, path, status,
  // durationMs, remote}. Default is silent.
  const logLevel = flags.log || process.env.LAZYCLAW_LOG_LEVEL || null;
  const { createLogger } = await import('../logger.mjs');
  const logger = logLevel ? createLogger({ level: logLevel }) : null;
  // Cost cap parsing: any --cost-cap-<currency> <amount> flag pair
  // contributes one entry to the costCap map. Currency codes are upper-
  // cased to match what costFromUsage's rate cards produce. Bad/zero
  // values are silently skipped — the daemon should never reject a
  // request because the operator typo'd the limit.
  const costCap = {};
  for (const [k, v] of Object.entries(flags)) {
    if (!k.startsWith('cost-cap-')) continue;
    const cur = k.slice('cost-cap-'.length).toUpperCase();
    const amt = Number(v);
    if (Number.isFinite(amt) && amt > 0) costCap[cur] = amt;
  }
  const costCapOrNull = Object.keys(costCap).length > 0 ? costCap : null;
  // Workflow state dir: --workflow-state-dir flag wins, then env, then
  // the CLI's default of `.workflow-state` (cwd-relative). Mirrors the
  // CLI's `lazyclaw run --dir` resolution so `inspect` and the daemon
  // see the same files.
  const workflowStateDirValue = flags['workflow-state-dir']
    || process.env.LAZYCLAW_WORKFLOW_STATE_DIR
    || '.workflow-state';
  const cfgDir = path.dirname(configPath());
  let d;
  try {
    d = await startDaemon({
      port: Number.isFinite(port) ? port : 0,
      once,
      readConfig,
      // `lazyclaw daemon` exposes mutation endpoints (POST /providers,
      // PUT /rates/<key>, etc.) only when an auth token is configured
      // — without one the daemon is loopback-only but still untrusted
      // (any process on the box can hit it). dashboard subcommand sets
      // writeConfig unconditionally because it always runs as the user.
      writeConfig: authToken ? writeConfig : undefined,
      sessionsDirGetter: () => cfgDir,
      sessionsMod,
      version: () => readVersionFromRepo(),
      workflowStateDir: () => workflowStateDirValue,
      authToken: authToken || undefined,
      allowedOrigins,
      rateLimit,
      responseCache,
      logger,
      costCap: costCapOrNull,
    });
  } catch (err) {
    // `lazyclaw daemon` exits cleanly on EADDRINUSE with a readable
    // message instead of the historical unhandled-error stack trace.
    // Unlike `lazyclaw dashboard`, daemon doesn't auto-kill the prior
    // listener — bare daemon callers are usually scripts that expect
    // exact port semantics, so we surface the failure and let them
    // choose (re-run with --port 0 for random, or kill the holdout).
    if (err?.code === 'EADDRINUSE') {
      process.stderr.write(
        `lazyclaw daemon: port ${port} is in use.\n` +
        `  Re-run with --port 0 for a random port, or free the port:\n` +
        `    lsof -ti tcp:${port} | xargs kill -9\n`
      );
      process.exit(2);
    }
    throw err;
  }
  // Print the bound port immediately so test/script callers can pick it up
  // even when we asked for port 0. Indicate auth presence (not the token)
  // and the allowed-origin count (not the values, just whether browser
  // access has been opened).
  process.stdout.write(JSON.stringify({
    ok: true, url: `http://127.0.0.1:${d.port}`, port: d.port, once,
    auth: !!authToken,
    allowedOriginCount: allowedOrigins.length,
    rateLimit: rateLimit ? { capacity: rateLimit.capacity, refillPerSec: rateLimit.refillPerSec } : null,
    responseCache: !!responseCache,
    log: logLevel || null,
    costCap: costCapOrNull,
  }) + '\n');
  if (!once) {
    // Forward SIGINT/SIGTERM to a graceful shutdown with a hard timeout
    // (default 10 s, override with --shutdown-timeout-ms). Second signal
    // bypasses the wait and exits immediately — the orchestrator's "I
    // mean it" signal.
    const { gracefulShutdown } = await import('../daemon.mjs');
    const timeoutMs = flags['shutdown-timeout-ms'] ? parseInt(flags['shutdown-timeout-ms'], 10) : 10_000;
    // Always-on: make an unhandled crash observable + drain sockets, then
    // exit non-zero so a service manager restarts us (vs. silent death).
    installCrashHandlers({ label: 'daemon', logger, stop: () => gracefulShutdown(d.server, timeoutMs) });
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) {
        if (logger) logger.warn('shutdown.force', { reason: 'second signal' });
        return process.exit(1);
      }
      shuttingDown = true;
      if (logger) logger.info('shutdown.begin', { timeoutMs });
      const result = await gracefulShutdown(d.server, timeoutMs);
      if (logger) logger.info('shutdown.end', result);
      process.exit(result.forced ? 1 : 0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } else {
    // In once mode, exit naturally after the server closes.
    d.server.on('close', () => process.exit(0));
  }
}
