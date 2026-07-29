// tests/f-service-install.test.mjs — Phase 1b: always-on service install.
// Pure unit-file builders + backend detection + an injected-deps apply layer
// so install/uninstall/status are testable without touching launchctl,
// systemctl, real processes, or the real filesystem.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ServiceError,
  servicePaths,
  detectBackend,
  buildLaunchdPlist,
  buildSystemdUnit,
  installService,
  uninstallService,
  serviceStatus,
} from '../lib/service_install.mjs';

const SPEC = {
  name: 'daemon',
  execPath: '/usr/bin/node',
  args: ['/opt/lazyclaw/cli.mjs', 'daemon', '--port', '19610'],
  workingDir: '/opt/lazyclaw',
  configDir: '/home/u/.lazyclaw',
  logfile: '/home/u/.lazyclaw/daemon.log',
  description: 'lazyclaw always-on daemon',
};

test('detectBackend: platform + systemctl + override', () => {
  assert.equal(detectBackend({ platform: 'darwin' }), 'launchd');
  assert.equal(detectBackend({ platform: 'linux', hasSystemctl: true }), 'systemd');
  assert.equal(detectBackend({ platform: 'linux', hasSystemctl: false }), 'fallback');
  assert.equal(detectBackend({ platform: 'win32' }), 'fallback');
  assert.equal(detectBackend({ platform: 'darwin', override: 'fallback' }), 'fallback');
});

test('servicePaths: launchd / systemd / pidfile / logfile', () => {
  const p = servicePaths('daemon', { home: '/home/u', configDir: '/home/u/.lazyclaw' });
  assert.equal(p.launchd, '/home/u/Library/LaunchAgents/com.lazyclaw.daemon.plist');
  assert.equal(p.systemd, '/home/u/.config/systemd/user/lazyclaw-daemon.service');
  assert.equal(p.pidfile, '/home/u/.lazyclaw/daemon.pid');
  assert.equal(p.logfile, '/home/u/.lazyclaw/daemon.log');
});

test('buildLaunchdPlist: always-on (RunAtLoad+KeepAlive) with full argv', () => {
  const xml = buildLaunchdPlist(SPEC);
  assert.match(xml, /<key>Label<\/key><string>com\.lazyclaw\.daemon<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, /<string>\/usr\/bin\/node<\/string>/);
  assert.match(xml, /<string>daemon<\/string>/);
  assert.match(xml, /<string>--port<\/string>/);
  assert.match(xml, /<key>StandardErrorPath<\/key><string>\/home\/u\/\.lazyclaw\/daemon\.log<\/string>/);
});

test('buildSystemdUnit: Restart=always + ExecStart with argv', () => {
  const unit = buildSystemdUnit(SPEC);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/opt\/lazyclaw\/cli\.mjs daemon --port 19610/);
  assert.match(unit, /WantedBy=default\.target/);
  assert.match(unit, /Description=lazyclaw always-on daemon/);
});

// ---- injected-deps apply layer ----
function fakeDeps() {
  const files = new Map();
  const calls = [];
  return {
    files, calls,
    fs: {
      mkdirSync: () => {},
      writeFileSync: (p, c) => files.set(p, c),
      existsSync: (p) => files.has(p),
      rmSync: (p) => files.delete(p),
      readFileSync: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
    },
    spawnSync: (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: '', stderr: '' }; },
    spawn: (cmd, args) => { calls.push(['spawn', cmd, ...args]); return { pid: 4242, unref() {} }; },
  };
}

test('installService launchd: writes plist + launchctl load', () => {
  const d = fakeDeps();
  const r = installService({ ...SPEC, backend: 'launchd', home: '/home/u' }, d);
  assert.equal(r.backend, 'launchd');
  const plist = '/home/u/Library/LaunchAgents/com.lazyclaw.daemon.plist';
  assert.ok(d.files.has(plist));
  assert.match(d.files.get(plist), /KeepAlive/);
  assert.ok(d.calls.some(([c, a]) => c === 'launchctl' && a === 'load'));
});

test('installService systemd: writes unit + systemctl enable --now', () => {
  const d = fakeDeps();
  const r = installService({ ...SPEC, backend: 'systemd', home: '/home/u' }, d);
  assert.equal(r.backend, 'systemd');
  assert.ok(d.files.has('/home/u/.config/systemd/user/lazyclaw-daemon.service'));
  assert.ok(d.calls.some(([c, ...a]) => c === 'systemctl' && a.includes('enable')));
  assert.ok(d.calls.some(([c, ...a]) => c === 'systemctl' && a.includes('daemon-reload')));
});

test('installService fallback: detached spawn + pidfile', () => {
  const d = fakeDeps();
  const r = installService({ ...SPEC, backend: 'fallback', home: '/home/u' }, d);
  assert.equal(r.backend, 'fallback');
  assert.equal(r.pid, 4242);
  assert.equal(d.files.get('/home/u/.lazyclaw/daemon.pid'), '4242');
  assert.ok(d.calls.some(([c]) => c === 'spawn'));
});

test('uninstallService: removes artifact + unloads', () => {
  const d = fakeDeps();
  installService({ ...SPEC, backend: 'launchd', home: '/home/u' }, d);
  const plist = '/home/u/Library/LaunchAgents/com.lazyclaw.daemon.plist';
  assert.ok(d.files.has(plist));
  uninstallService({ ...SPEC, backend: 'launchd', home: '/home/u' }, d);
  assert.ok(!d.files.has(plist));
  assert.ok(d.calls.some(([c, a]) => c === 'launchctl' && a === 'unload'));
});

test('serviceStatus fallback: reads pidfile + liveness', () => {
  const d = fakeDeps();
  d.files.set('/home/u/.lazyclaw/daemon.pid', '4242');
  const alive = serviceStatus({ ...SPEC, backend: 'fallback', home: '/home/u' }, { ...d, isAlive: (pid) => pid === 4242 });
  assert.equal(alive.installed, true);
  assert.equal(alive.running, true);
  assert.equal(alive.pid, 4242);
  const dead = serviceStatus({ ...SPEC, backend: 'fallback', home: '/home/u' }, { ...d, isAlive: () => false });
  assert.equal(dead.running, false);
});

// ---- fallback pidfile reader tolerates both writer formats ----
//
// `<configDir>/gateway.pid` is written as a bare pid by installService's
// fallback backend AND, independently, as `{ pid, port }` JSON by
// `lazyclaw gateway` (commands/gateway.mjs) when the service-spawned child
// starts up and overwrites it. serviceStatus/uninstallService must be able
// to read either shape rather than getting NaN out of the JSON case.

test('serviceStatus fallback: a bare-pid file still reads correctly (pre-existing behaviour)', () => {
  const d = fakeDeps();
  d.files.set('/home/u/.lazyclaw/daemon.pid', '4242');
  const st = serviceStatus({ ...SPEC, backend: 'fallback', home: '/home/u' }, { ...d, isAlive: (pid) => pid === 4242 });
  assert.equal(st.running, true);
  assert.equal(st.pid, 4242);
});

test('serviceStatus fallback: a {"pid":N,"port":P} file (gateway\'s own format) reads pid N', () => {
  const d = fakeDeps();
  d.files.set('/home/u/.lazyclaw/daemon.pid', JSON.stringify({ pid: 4242, port: 19600 }));
  const st = serviceStatus({ ...SPEC, backend: 'fallback', home: '/home/u' }, { ...d, isAlive: (pid) => pid === 4242 });
  assert.equal(st.installed, true);
  assert.equal(st.running, true);
  assert.equal(st.pid, 4242);
});

test('serviceStatus fallback: a malformed pidfile is treated as no pid, not a throw', () => {
  const d = fakeDeps();
  d.files.set('/home/u/.lazyclaw/daemon.pid', 'not json and not a number');
  const st = serviceStatus({ ...SPEC, backend: 'fallback', home: '/home/u' }, { ...d, isAlive: () => true });
  assert.equal(st.installed, true);
  assert.equal(st.running, false);
  assert.equal(st.pid, null);
});

test('serviceStatus fallback: JSON without a usable pid is treated as no pid', () => {
  const d = fakeDeps();
  d.files.set('/home/u/.lazyclaw/daemon.pid', JSON.stringify({ port: 19600 }));
  const st = serviceStatus({ ...SPEC, backend: 'fallback', home: '/home/u' }, { ...d, isAlive: () => true });
  assert.equal(st.running, false);
  assert.equal(st.pid, null);
});

test('uninstallService fallback: a {"pid":N,"port":P} file kills pid N', () => {
  const d = fakeDeps();
  d.files.set('/home/u/.lazyclaw/daemon.pid', JSON.stringify({ pid: 4242, port: 19600 }));
  const killed = [];
  const origKill = process.kill;
  process.kill = (pid) => killed.push(pid);
  try {
    const r = uninstallService({ ...SPEC, backend: 'fallback', home: '/home/u' }, d);
    assert.equal(r.killed, 4242);
    assert.deepEqual(killed, [4242]);
  } finally {
    process.kill = origKill;
  }
});

test('uninstallService fallback: a malformed pidfile is treated as no pid, not a throw', () => {
  const d = fakeDeps();
  d.files.set('/home/u/.lazyclaw/daemon.pid', 'garbage');
  const killed = [];
  const origKill = process.kill;
  process.kill = (pid) => killed.push(pid);
  try {
    // Must not throw, and must not attempt to signal a garbage "pid".
    const r = uninstallService({ ...SPEC, backend: 'fallback', home: '/home/u' }, d);
    assert.deepEqual(killed, []);
    assert.ok(Number.isNaN(r.killed), 'no usable pid, same as the pre-existing bare parseInt behaviour');
  } finally {
    process.kill = origKill;
  }
});

test('installService: unknown backend throws ServiceError', () => {
  const d = fakeDeps();
  let err = null;
  try { installService({ ...SPEC, backend: 'nope', home: '/home/u' }, d); } catch (e) { err = e; }
  assert.ok(err instanceof ServiceError);
});

// ---- command glue: _buildSpec wraps the daemon argv + picks a backend ----
test('cmdService._buildSpec: wraps `daemon` with flags + injects config dir', async () => {
  const { _buildSpec } = await import('../commands/service.mjs');
  const spec = _buildSpec('daemon', { port: 19610, log: 'info', backend: 'fallback' }, '/cfg', {
    hasSystemctl: () => false, cliPath: () => '/x/cli.mjs', cwd: '/w',
  });
  assert.deepEqual(spec.args, ['/x/cli.mjs', 'daemon', '--port', '19610', '--log', 'info']);
  assert.equal(spec.backend, 'fallback');

  // No --port -> defaults to 19600, the port the channel listeners dial.
  const dflt = _buildSpec('daemon', { backend: 'fallback' }, '/cfg', { hasSystemctl: () => false, cliPath: () => '/x/cli.mjs' });
  assert.deepEqual(dflt.args, ['/x/cli.mjs', 'daemon', '--port', '19600']);

  // The gateway surface wraps `gateway` (not `daemon`) and forwards --channels.
  const gw = _buildSpec('gateway', { backend: 'fallback', channels: 'slack,telegram' }, '/cfg', { hasSystemctl: () => false, cliPath: () => '/x/cli.mjs' });
  assert.deepEqual(gw.args, ['/x/cli.mjs', 'gateway', '--port', '19600', '--channels', 'slack,telegram']);
  assert.equal(gw.name, 'gateway');
  assert.equal(spec.configDir, '/cfg');
  assert.equal(spec.workingDir, '/w');
  assert.equal(spec.env.LAZYCLAW_CONFIG_DIR, '/cfg');
  assert.equal(spec.name, 'daemon');
});
