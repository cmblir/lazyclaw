// lib/gateway_guard.mjs — boot-time safety guards + crash handlers for the
// always-on gateway (the daemon and the channel listeners).
//
// These are deliberately small, pure, and dependency-free so every entry
// point that opens a remote inbound surface can call them the same way and
// fail CLOSED before a single message is accepted.

export class GatewayGuardError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GatewayGuardError';
    this.code = code || 'GATEWAY_GUARD';
  }
}

// `security.allowUnattendedSensitive` is a GLOBAL opt-in read by
// mas/tool_runner.mjs for EVERY sensitive tool call (bash/write/net). It
// bypasses the fail-closed approval gate process-wide. Combined with an
// always-on channel or daemon surface, an inbound chat message could drive
// bash/write with no human in the loop — remote-prompt-injection-to-RCE.
// Refuse to start such a surface while the flag is set.
export function assertUnattendedSafe(cfg, { surface = 'channel' } = {}) {
  if (cfg && cfg.security && cfg.security.allowUnattendedSensitive === true) {
    throw new GatewayGuardError(
      `refusing to start a ${surface} surface while security.allowUnattendedSensitive=true: ` +
        `that flag bypasses the fail-closed tool-approval gate for EVERY inbound message, so an ` +
        `always-on ${surface} could run bash/write on remote command (RCE). Remove ` +
        `security.allowUnattendedSensitive from your config (the ${surface} path does not need it), ` +
        `or run sensitive tools only in an interactive session.`,
      'UNATTENDED_SENSITIVE_WITH_CHANNEL',
    );
  }
}

// An unattended service (started under launchd/systemd, no operator at a
// terminal) with an empty pairing allowlist answers anyone who can reach
// it. Require at least one paired sender before booting in service mode.
export function assertServicePairing(cfg, { service = false, surface = 'channel' } = {}) {
  if (!service) return;
  const allow = Array.isArray(cfg && cfg.pairing)
    ? cfg.pairing.filter((p) => p && p.id != null)
    : [];
  if (allow.length === 0) {
    throw new GatewayGuardError(
      `refusing to start ${surface} in unattended --service mode with an empty pairing allowlist: ` +
        `the agent would answer anyone who can reach it, 24/7. Pair at least one sender first: ` +
        `lazyclaw pairing add <id>.`,
      'SERVICE_REQUIRES_PAIRING',
    );
  }
}

// Process-level crash handlers for long-running processes. There are none in
// the codebase, so a single unhandledRejection / uncaughtException kills the
// always-on process with no log and no clean socket shutdown. This makes the
// crash OBSERVABLE (structured log) and CLEAN (best-effort stop), then exits
// non-zero so a service manager (launchd KeepAlive / systemd Restart) restarts
// it. Deliberately NOT installed on the interactive TUI path — Ink manages the
// terminal and needs its own handling (see tui/repl.mjs).
//
// Idempotent: a second call is a no-op and returns the same cleanup fn.
const INSTALLED = Symbol.for('lazyclaw.gateway.crashHandlers');

export function installCrashHandlers({ label = 'lazyclaw', logger = null, stop = null, exit = null } = {}) {
  if (process[INSTALLED]) return process[INSTALLED];
  const doExit = typeof exit === 'function' ? exit : (code) => process.exit(code);

  const report = (kind, err) => {
    const detail = {
      level: 'fatal',
      msg: 'crash',
      label,
      kind,
      error: (err && (err.stack || err.message)) || String(err),
    };
    if (logger && typeof logger.error === 'function') logger.error('crash', detail);
    else process.stderr.write(JSON.stringify(detail) + '\n');
  };

  const handle = (kind) => async (err) => {
    report(kind, err);
    if (typeof stop === 'function') {
      try { await stop(); } catch { /* best-effort: we're already crashing */ }
    }
    doExit(1);
  };

  const onRej = handle('unhandledRejection');
  const onExc = handle('uncaughtException');
  process.on('unhandledRejection', onRej);
  process.on('uncaughtException', onExc);

  const cleanup = () => {
    process.removeListener('unhandledRejection', onRej);
    process.removeListener('uncaughtException', onExc);
    delete process[INSTALLED];
  };
  process[INSTALLED] = cleanup;
  return cleanup;
}
