// tests/f-daemon-lifecycle.test.mjs — C2: bare daemon lifecycle (stop|status|logs)
// + launchd status running/pid parity.
//
// Pure helpers are imported and exercised directly (no long-lived daemon
// spawn, which is flaky). The CLI surface is exercised with spawnSync against
// cli.mjs to pin the pre-fix gap: `daemon status` / `daemon stop` previously
// did not exist (unknown subcommand / exit 2).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'cli.mjs');

import {
  _daemonPidfilePath,
  readDaemonPidfile,
  daemonStatus,
  daemonStop,
} from '../commands/daemon.mjs';
import { serviceStatus } from '../lib/service_install.mjs';

function tmpCfgDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-daemon-'));
}

// ---- PART A: pure pidfile/status/stop helpers ----

test('daemonStatus: no pidfile => running:false', () => {
  const dir = tmpCfgDir();
  const st = daemonStatus({ configDir: dir });
  assert.equal(st.running, false);
  assert.equal(st.pid, null);
});

test('daemonStatus: live pid => running:true with pid + port', () => {
  const dir = tmpCfgDir();
  fs.writeFileSync(
    _daemonPidfilePath(dir),
    JSON.stringify({ pid: process.pid, port: 12345 }),
  );
  const st = daemonStatus({ configDir: dir });
  assert.equal(st.running, true);
  assert.equal(st.pid, process.pid);
  assert.equal(st.port, 12345);
});

test('daemonStatus: stale pid => running:false + pidfile cleaned up', () => {
  const dir = tmpCfgDir();
  const pf = _daemonPidfilePath(dir);
  // A pid that is virtually guaranteed not to be alive.
  const deadPid = 2147483646;
  fs.writeFileSync(pf, JSON.stringify({ pid: deadPid, port: 999 }));
  const st = daemonStatus({ configDir: dir });
  assert.equal(st.running, false);
  assert.equal(fs.existsSync(pf), false, 'stale pidfile should be removed');
});

test('readDaemonPidfile: missing => null', () => {
  const dir = tmpCfgDir();
  assert.equal(readDaemonPidfile(_daemonPidfilePath(dir)), null);
});

test('daemonStop: no pidfile => not running, exit 0', () => {
  const dir = tmpCfgDir();
  const r = daemonStop({ configDir: dir }, { kill: () => {}, isAlive: () => false });
  assert.equal(r.running, false);
  assert.equal(r.exitCode, 0);
});

test('daemonStop: live pid => SIGTERM sent + pidfile removed', () => {
  const dir = tmpCfgDir();
  const pf = _daemonPidfilePath(dir);
  fs.writeFileSync(pf, JSON.stringify({ pid: 4242, port: 19600 }));
  const signals = [];
  // Alive on the initial liveness check, then dead after SIGTERM so the
  // SIGKILL fallback never fires.
  let aliveCalls = 0;
  const r = daemonStop(
    { configDir: dir },
    {
      kill: (pid, sig) => signals.push([pid, sig]),
      isAlive: () => (aliveCalls++ === 0),
    },
  );
  assert.equal(r.running, true);
  assert.equal(r.pid, 4242);
  assert.deepEqual(signals[0], [4242, 'SIGTERM']);
  assert.equal(fs.existsSync(pf), false, 'pidfile removed on stop');
});

// ---- PART B: launchd status reports running + pid ----

function launchdDeps({ loaded, pid }) {
  return {
    fs: { existsSync: () => true },
    isAlive: (p) => p === pid,
    spawnSync: () => {
      if (!loaded) return { status: 1, stdout: '', stderr: 'Could not find service' };
      const out = pid != null
        ? `{\n\t"PID" = ${pid};\n\t"Label" = "com.pompos.daemon";\n};`
        : `{\n\t"Label" = "com.pompos.daemon";\n};`;
      return { status: 0, stdout: out, stderr: '' };
    },
  };
}

test('serviceStatus launchd: loaded with PID => running:true + pid', () => {
  const st = serviceStatus(
    { name: 'daemon', backend: 'launchd', home: '/home/u' },
    launchdDeps({ loaded: true, pid: 5151 }),
  );
  assert.equal(st.installed, true);
  assert.equal(st.running, true);
  assert.equal(st.pid, 5151);
});

test('serviceStatus launchd: not loaded => running:false', () => {
  const st = serviceStatus(
    { name: 'daemon', backend: 'launchd', home: '/home/u' },
    launchdDeps({ loaded: false }),
  );
  assert.equal(st.running, false);
});

// ---- CLI surface: subcommands exist (pins the pre-fix gap) ----

function runCli(args, cfgDir) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, POMPOS_CONFIG_DIR: cfgDir },
    encoding: 'utf8',
  });
}

test('CLI: `daemon status` exists and reports running:false when nothing started', () => {
  const dir = tmpCfgDir();
  const r = runCli(['daemon', 'status'], dir);
  assert.equal(r.status, 0, `daemon status should exit 0, got ${r.status}\n${r.stderr}`);
  const parsed = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(parsed.running, false);
});

test('CLI: `daemon stop` with nothing running => not running, exit 0', () => {
  const dir = tmpCfgDir();
  const r = runCli(['daemon', 'stop'], dir);
  assert.equal(r.status, 0, `daemon stop should exit 0, got ${r.status}\n${r.stderr}`);
});
