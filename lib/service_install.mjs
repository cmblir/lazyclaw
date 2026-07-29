// lib/service_install.mjs — install a lazyclaw long-running command as an
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
// pid. But `<configDir>/<name>.pid` is also the exact path `lazyclaw gateway`
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

export function servicePaths(name, { home = os.homedir(), configDir } = {}) {
  const cfg = configDir || path.join(home, '.lazyclaw');
  return {
    launchd: path.join(home, 'Library', 'LaunchAgents', `com.lazyclaw.${name}.plist`),
    systemd: path.join(home, '.config', 'systemd', 'user', `lazyclaw-${name}.service`),
    pidfile: path.join(cfg, `${name}.pid`),
    logfile: path.join(cfg, `${name}.log`),
  };
}

export function detectBackend({ platform = process.platform, hasSystemctl = false, override = null } = {}) {
  if (override) return override;
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux' && hasSystemctl) return 'systemd';
  return 'fallback';
}

export function buildLaunchdPlist({ name, execPath, args, workingDir, logfile, env = {} }) {
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
  <key>Label</key><string>com.lazyclaw.${xmlEscape(name)}</string>
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
  // the argv simple (paths/flags lazyclaw produces have no shell metachars),
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
  const p = servicePaths(name, { home, configDir });
  const log = logfile || p.logfile;

  if (backend === 'launchd') {
    deps.fs.mkdirSync(path.dirname(p.launchd), { recursive: true });
    deps.fs.writeFileSync(p.launchd, buildLaunchdPlist({ name, execPath, args, workingDir, logfile: log, env }));
    deps.spawnSync('launchctl', ['unload', p.launchd], { stdio: 'ignore' });
    const r = deps.spawnSync('launchctl', ['load', p.launchd], { encoding: 'utf8' });
    if (r && r.status !== 0) throw new ServiceError(`launchctl load failed: ${r.stderr || r.status}`, 'SERVICE_LAUNCHD_FAIL');
    return { backend, target: p.launchd };
  }

  if (backend === 'systemd') {
    deps.fs.mkdirSync(path.dirname(p.systemd), { recursive: true });
    deps.fs.writeFileSync(p.systemd, buildSystemdUnit({ description, execPath, args, workingDir, env }));
    deps.spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    const r = deps.spawnSync('systemctl', ['--user', 'enable', '--now', `lazyclaw-${name}.service`], { encoding: 'utf8' });
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
  const p = servicePaths(name, { home, configDir });

  if (backend === 'launchd') {
    if (deps.fs.existsSync(p.launchd)) {
      deps.spawnSync('launchctl', ['unload', p.launchd], { stdio: 'ignore' });
      deps.fs.rmSync(p.launchd);
    }
    return { backend, removed: p.launchd };
  }
  if (backend === 'systemd') {
    deps.spawnSync('systemctl', ['--user', 'disable', '--now', `lazyclaw-${name}.service`], { stdio: 'ignore' });
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
  const p = servicePaths(name, { home, configDir });

  if (backend === 'launchd') {
    const installed = deps.fs.existsSync(p.launchd);
    // `launchctl list <label>` exits non-zero when the service isn't loaded
    // and otherwise prints a dict that carries `"PID" = <n>;` only while the
    // process is actually running (a loaded-but-idle KeepAlive job omits it).
    // Parse that to report running+pid like the systemd/fallback branches.
    const label = `com.lazyclaw.${name}`;
    const r = deps.spawnSync('launchctl', ['list', label], { encoding: 'utf8' });
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
    const r = deps.spawnSync('systemctl', ['--user', 'is-active', `lazyclaw-${name}.service`], { encoding: 'utf8' });
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
