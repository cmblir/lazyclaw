// commands/service.mjs — `pompos service <install|uninstall|status|restart>`.
// Wraps a pompos long-running command as an always-on OS service via
// lib/service_install.mjs (launchd / systemd / detached-fallback).
//
// v1 manages the DAEMON — the single always-on agent core. Once the channel
// listeners forward into the daemon's /inbound (next phase), the daemon is
// the one process that has to stay up; channel surfaces graduate to their own
// service targets in a later phase.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { configPath, readConfig } from '../lib/config.mjs';
import { resolvePort } from '../lib/ports.mjs';
import { assertUnattendedSafe, assertServicePairing } from '../lib/gateway_guard.mjs';
import { detectBackend, installService, uninstallService, serviceStatus } from '../lib/service_install.mjs';

const SUPPORTED_SURFACES = new Set(['daemon', 'gateway']);

function hasSystemctl() {
  try {
    const r = spawnSync('systemctl', ['--version'], { stdio: 'ignore' });
    return !r.error && r.status === 0;
  } catch { return false; }
}

function cliPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
}

// Exported for tests: builds the service spec (wrapped argv + backend) without
// any side effects.
export function _buildSpec(surface, flags = {}, cfgDir = '', deps = {}) {
  const hasSystemd = typeof deps.hasSystemctl === 'function' ? deps.hasSystemctl() : hasSystemctl();
  const args = [deps.cliPath ? deps.cliPath() : cliPath(), surface];
  // Default the service to the well-known port the channel listeners dial
  // (the LAZYCLAW_DAEMON_URL default), so `service install` + `* listen`
  // work together out of the box. Bare `pompos daemon` still defaults to a
  // random port for ad-hoc / scripted use. Resolved the same way cmdService's
  // own EADDRINUSE warning below is, so the two never disagree.
  args.push('--port', String(resolvePort(surface, flags, deps.cfg)));
  if (flags['auth-token']) args.push('--auth-token', String(flags['auth-token']));
  if (flags.log) args.push('--log', String(flags.log));
  if (flags.channels) args.push('--channels', String(flags.channels));
  return {
    name: surface,
    surface,
    execPath: process.execPath,
    args,
    workingDir: deps.cwd || process.cwd(),
    configDir: cfgDir,
    description: `pompos always-on ${surface}`,
    env: { LAZYCLAW_CONFIG_DIR: cfgDir },
    backend: detectBackend({ override: flags.backend || null, hasSystemctl: hasSystemd }),
  };
}

export async function cmdService(sub, positional = [], flags = {}) {
  const surface = (positional[0] || 'daemon').toLowerCase();
  if (!SUPPORTED_SURFACES.has(surface)) {
    console.error(`service: only '${[...SUPPORTED_SURFACES].join("', '")}' is supported in this version (channel gateway lands in a later phase). Got: ${surface}`);
    process.exit(2);
  }
  const cfg = readConfig();
  const cfgDir = path.dirname(configPath());

  // Fail closed before installing: never wrap a remote surface as a service
  // while the global unattended-sensitive tool override is on (RCE). Channel
  // surfaces additionally require a non-empty pairing allowlist.
  try {
    assertUnattendedSafe(cfg, { surface });
    if (surface !== 'daemon') assertServicePairing(cfg, { service: true, surface });
  } catch (e) { console.error(e.message); process.exit(2); }

  // A present-but-invalid --port throws InvalidPortError (lib/ports.mjs) —
  // fail closed here rather than baking a typo'd port into an installed
  // service's argv with no warning at install time.
  let spec;
  try { spec = _buildSpec(surface, flags, cfgDir, { cfg }); }
  catch (e) { console.error(e.message); process.exit(2); }
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

  try {
    if (sub === 'install') {
      const r = installService(spec);
      emit({ ok: true, action: 'install', ...r });
      if (r.backend === 'fallback') {
        process.stderr.write('note: no service manager detected — running detached with a pidfile. This survives the terminal but NOT a reboot. Re-run `pompos service install` after reboot, or install launchd/systemd.\n');
        // The detached child's fate is invisible (stdio ignored), so verify it
        // actually stayed up — a daemon that hit EADDRINUSE (port already in
        // use) exits within ~200ms. Surface that instead of a false "ok".
        await new Promise((s) => setTimeout(s, 800));
        const st = serviceStatus(spec);
        if (!st.running) {
          const port = resolvePort(surface, flags, cfg);
          process.stderr.write(`warning: the daemon did not stay up — port ${port} may already be in use (a daemon is already running?). Check: lsof -ti tcp:${port}. Free it or pass --port, then re-run.\n`);
        }
      }
      return;
    }
    if (sub === 'uninstall' || sub === 'remove') {
      emit({ ok: true, action: 'uninstall', ...uninstallService(spec) });
      return;
    }
    if (sub === 'status') {
      emit({ ok: true, action: 'status', ...serviceStatus(spec) });
      return;
    }
    if (sub === 'restart') {
      try { uninstallService(spec); } catch { /* not installed yet */ }
      emit({ ok: true, action: 'restart', ...installService(spec) });
      return;
    }
  } catch (e) {
    console.error(`service: ${e.message}`);
    process.exit(2);
  }

  console.error('Usage: pompos service <install|uninstall|status|restart> [daemon|gateway] [--port N] [--auth-token T] [--log LEVEL] [--channels a,b] [--backend launchd|systemd|fallback]');
  process.exit(2);
}
