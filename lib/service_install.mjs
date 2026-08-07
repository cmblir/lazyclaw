// lib/service_install.mjs — install a pompos long-running command as an
// always-on OS service across three backends:
//   - launchd  (macOS): plist with RunAtLoad + KeepAlive
//   - systemd  (Linux user unit): Restart=always
//   - fallback (no service manager): detached child + pidfile
//
// The unit-file builders + backend detection are PURE. The apply layer
// (install/uninstall/status) takes injectable deps (fs/spawn/spawnSync/isAlive)
// so it is fully testable without touching the real OS.
//
// NOTE: this is distinct from cron.mjs's plist machinery, which emits a
// StartCalendarInterval (scheduled) plist with RunAtLoad=false — the opposite
// of an always-on service.

import os from 'node:os';
import path from 'node:path';
import fsReal from 'node:fs';
import { spawn as spawnReal, spawnSync as spawnSyncReal } from 'node:child_process';
import { isProcessAlive } from '../loops.mjs';

export class ServiceError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ServiceError';
    this.code = code || 'SERVICE_ERR';
  }
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The fallback backend's own pidfile (installService below) holds a bare
// pid. But `<configDir>/<name>.pid` is also the exact path `pompos gateway`
// writes its own `{ pid, port }` JSON pidfile to (see
// commands/gateway.mjs's _gatewayPidfilePath) — the two writers agree on the
// pid value (the service-spawned child IS the process gateway records) but
// disagree on format, since gateway's own writer isn't changing. Parse
// either shape here so a service-installed gateway still reports correctly.
// Returns NaN — same as a bare parseInt would — when neither shape yields a
// usable pid, so callers' existing Number.isFinite(pid) checks are unchanged.
function parseFallbackPid(raw) {
  try {
    const obj = JSON.parse(raw);
    const pid = parseInt(obj?.pid, 10);
    if (Number.isFinite(pid)) return pid;
  } catch { /* not JSON: fall through to bare-pid parsing */ }
  return parseInt(raw, 10);
}

// ---- pure helpers ----

// The service identity is spelled into three places that must agree: the plist
// filename, the `Label` inside it, and the argument `launchctl list` is given.
// They used to be built independently at four call sites; they are derived from
// one prefix here so a rename cannot desynchronise them again.
function identityFor(prefix, name, { home = os.homedir(), configDir } = {}) {
  const cfg = configDir || path.join(home, `.${prefix}`);
  const label = `com.${prefix}.${name}`;
  const unit = `${prefix}-${name}.service`;
  return {
    launchd: path.join(home, 'Library', 'LaunchAgents', `${label}.plist`),
    systemd: path.join(home, '.config', 'systemd', 'user', unit),
    label,
    unit,
    pidfile: path.join(cfg, `${name}.pid`),
    logfile: path.join(cfg, `${name}.log`),
  };
}

export function servicePaths(name, opts = {}) {
  return identityFor('pompos', name, opts);
}

// The same identity spelled the pre-rename way. A service installed before the
// rename is a FILE ON DISK that launchd/systemd already has loaded under the old
// label, and the OS knows nothing about the new one.
export function legacyServicePaths(name, opts = {}) {
  return identityFor('lazyclaw', name, opts);
}

// Which identity an operation must act on.
//
// Using the new name unconditionally is not a cosmetic mismatch, it is data
// loss with a running process attached: `uninstall` would find no file and
// report success while the old job kept firing, `status` would report installed:
// false for a service that is up, and `install` would write a second unit — so
// the operator ends up with the same job scheduled twice and no way to remove
// either from the CLI. Adopting the file that is actually there keeps one
// identity per service, and a fresh install still gets the new name.
export function resolveServicePaths(name, opts = {}, depsIn = {}) {
  const fs = depsIn.fs || fsReal;
  const current = servicePaths(name, opts);
  if (opts.backend !== 'launchd' && opts.backend !== 'systemd') return current;
  const legacy = legacyServicePaths(name, opts);
  const key = opts.backend;
  const has = (p) => { try { return fs.existsSync(p); } catch { return false; } };
  if (!has(current[key]) && has(legacy[key])) return legacy;
  return current;
}

export function detectBackend({ platform = process.platform, hasSystemctl = false, override = null } = {}) {
  if (override) return override;
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux' && hasSystemctl) return 'systemd';
  return 'fallback';
}

export function buildLaunchdPlist({ name, label, execPath, args, workingDir, logfile, env = {} }) {
  const progArgs = [execPath, ...args]
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join('\n');
  const envBlock = Object.keys(env).length
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n` +
      Object.entries(env).map(([k, v]) => `    <key>${xmlEscape(k)}</key><string>${xmlEscape(v)}</string>`).join('\n') +
      `\n  </dict>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(label || `com.pompos.${name}`)}</string>
  <key>ProgramArguments</key>
  <array>
${progArgs}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key><string>${xmlEscape(workingDir)}</string>
  <key>StandardOutPath</key><string>${xmlEscape(logfile)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logfile)}</string>
${envBlock}</dict>
</plist>
`;
}

export function buildSystemdUnit({ description, execPath, args, workingDir, env = {} }) {
  // systemd ExecStart wants an absolute path + a single command line. We keep
  // the argv simple (paths/flags pompos produces have no shell metachars),
  // so a plain space-join is correct and readable.
  const exec = [execPath, ...args].join(' ');
  const envLines = Object.entries(env).map(([k, v]) => `Environment=${k}=${v}`).join('\n');
  return `[Unit]
Description=${description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exec}
WorkingDirectory=${workingDir}
Restart=always
RestartSec=3
${envLines ? envLines + '\n' : ''}
[Install]
WantedBy=default.target
`;
}

// ---- apply layer (side-effectful, injectable deps) ----

function resolveDeps(deps = {}) {
  return {
    fs: deps.fs || fsReal,
    spawnSync: deps.spawnSync || spawnSyncReal,
    spawn: deps.spawn || spawnReal,
    isAlive: deps.isAlive || isProcessAlive,
  };
}

export function installService(spec, depsIn = {}) {
  const { name, execPath, args, workingDir, env = {}, backend, description, home, configDir, logfile } = spec;
  const deps = resolveDeps(depsIn);
  const p = resolveServicePaths(name, { home, configDir, backend }, deps);
  const log = logfile || p.logfile;

  if (backend === 'launchd') {
    deps.fs.mkdirSync(path.dirname(p.launchd), { recursive: true });
    deps.fs.writeFileSync(p.launchd, buildLaunchdPlist({ name, label: p.label, execPath, args, workingDir, logfile: log, env }));
    deps.spawnSync('launchctl', ['unload', p.launchd], { stdio: 'ignore' });
    const r = deps.spawnSync('launchctl', ['load', p.launchd], { encoding: 'utf8' });
    if (r && r.status !== 0) throw new ServiceError(`launchctl load failed: ${r.stderr || r.status}`, 'SERVICE_LAUNCHD_FAIL');
    return { backend, target: p.launchd };
  }

  if (backend === 'systemd') {
    deps.fs.mkdirSync(path.dirname(p.systemd), { recursive: true });
    deps.fs.writeFileSync(p.systemd, buildSystemdUnit({ description, execPath, args, workingDir, env }));
    deps.spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    const r = deps.spawnSync('systemctl', ['--user', 'enable', '--now', p.unit], { encoding: 'utf8' });
    if (r && r.status !== 0) throw new ServiceError(`systemctl enable failed: ${r.stderr || r.status}`, 'SERVICE_SYSTEMD_FAIL');
    return { backend, target: p.systemd };
  }

  if (backend === 'fallback') {
    // No service manager: detach a child and record its pid. This survives
    // the launching terminal but NOT a reboot — the caller is told so.
    deps.fs.mkdirSync(path.dirname(p.pidfile), { recursive: true });
    const child = deps.spawn(execPath, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...env },
    });
    if (child && typeof child.unref === 'function') child.unref();
    deps.fs.writeFileSync(p.pidfile, String(child.pid));
    return { backend, pid: child.pid, pidfile: p.pidfile };
  }

  throw new ServiceError(`unknown service backend: ${backend}`, 'SERVICE_BAD_BACKEND');
}

export function uninstallService(spec, depsIn = {}) {
  const { name, backend, home, configDir } = spec;
  const deps = resolveDeps(depsIn);
  const p = resolveServicePaths(name, { home, configDir, backend }, deps);

  if (backend === 'launchd') {
    if (deps.fs.existsSync(p.launchd)) {
      deps.spawnSync('launchctl', ['unload', p.launchd], { stdio: 'ignore' });
      deps.fs.rmSync(p.launchd);
    }
    return { backend, removed: p.launchd };
  }
  if (backend === 'systemd') {
    deps.spawnSync('systemctl', ['--user', 'disable', '--now', p.unit], { stdio: 'ignore' });
    if (deps.fs.existsSync(p.systemd)) deps.fs.rmSync(p.systemd);
    deps.spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    return { backend, removed: p.systemd };
  }
  if (backend === 'fallback') {
    let pid = null;
    if (deps.fs.existsSync(p.pidfile)) {
      pid = parseFallbackPid(deps.fs.readFileSync(p.pidfile, 'utf8'));
      if (Number.isFinite(pid)) { try { process.kill(pid); } catch { /* already gone */ } }
      deps.fs.rmSync(p.pidfile);
    }
    return { backend, killed: pid };
  }
  throw new ServiceError(`unknown service backend: ${backend}`, 'SERVICE_BAD_BACKEND');
}

export function serviceStatus(spec, depsIn = {}) {
  const { name, backend, home, configDir } = spec;
  const deps = resolveDeps(depsIn);
  const p = resolveServicePaths(name, { home, configDir, backend }, deps);

  if (backend === 'launchd') {
    const installed = deps.fs.existsSync(p.launchd);
    // `launchctl list <label>` exits non-zero when the service isn't loaded
    // and otherwise prints a dict that carries `"PID" = <n>;` only while the
    // process is actually running (a loaded-but-idle KeepAlive job omits it).
    // Parse that to report running+pid like the systemd/fallback branches.
        const r = deps.spawnSync('launchctl', ['list', p.label], { encoding: 'utf8' });
    const loaded = !!r && r.status === 0;
    let pid = null;
    if (loaded && typeof r.stdout === 'string') {
      const m = r.stdout.match(/"PID"\s*=\s*(\d+)/);
      if (m) pid = parseInt(m[1], 10);
    }
    const running = pid != null && deps.isAlive(pid);
    return { backend, installed, running, pid, target: p.launchd };
  }
  if (backend === 'systemd') {
    const installed = deps.fs.existsSync(p.systemd);
    const r = deps.spawnSync('systemctl', ['--user', 'is-active', p.unit], { encoding: 'utf8' });
    const running = !!r && typeof r.stdout === 'string' && r.stdout.trim() === 'active';
    return { backend, installed, running, target: p.systemd };
  }
  if (backend === 'fallback') {
    if (!deps.fs.existsSync(p.pidfile)) return { backend, installed: false, running: false };
    const pid = parseFallbackPid(deps.fs.readFileSync(p.pidfile, 'utf8'));
    return { backend, installed: true, running: Number.isFinite(pid) && deps.isAlive(pid), pid: Number.isFinite(pid) ? pid : null };
  }
  throw new ServiceError(`unknown service backend: ${backend}`, 'SERVICE_BAD_BACKEND');
}
