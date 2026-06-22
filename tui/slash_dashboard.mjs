// tui/slash_dashboard.mjs — the /dashboard slash-command cluster, extracted
// verbatim from slash_dispatcher.mjs. Self-contained leaf with its own
// encapsulated module state (_dashboardSpawning / _dashboardChildPid). Imports
// only the shared leaf helpers, never the dispatcher (no cycle).

import { splitWhitespace } from './slash_helpers.mjs';

// /dashboard — open the lazyclaw web UI.
//
// v5.4.4 ROOT-CAUSE FIX (was: rapid repeated /dashboard within one chat
// session spawned 20+ daemon children).
//
// Original implementation:
//   probe /healthz → if !200, spawn detached `lazyclaw dashboard
//   --no-open` and poll for up to 3s.
//
// Failure mode that produced the 20+ spawn pile-up:
//   1. User types /dashboard. probe fails (no daemon). Spawn child A.
//   2. Child A begins binding port 19600. Takes ~500ms-2s to be ready.
//   3. User types /dashboard again BEFORE A is ready. probe still fails.
//      Spawn child B. Child B sees EADDRINUSE and calls _killPortOccupant
//      (cli.mjs:3611) which SIGTERMs child A. B takes over.
//   4. Repeat. Each /dashboard kills the previous daemon and starts a
//      new one. With autorepeat / many slash calls this stacks fast.
//
// Two-layer guard:
//   - A module-level _dashboardSpawning latch refuses concurrent spawn
//     attempts. While a spawn is in flight, /dashboard says so + returns
//     without firing another child.
//   - A _dashboardChildPid cache remembers the PID we already spawned;
//     subsequent calls check kill(pid, 0) to confirm the child is alive
//     and just open the browser without spawning.
//
// We probe both /healthz (HTTP) AND a raw net.connect port check so a
// slow-starting daemon (binding the listener but not yet answering HTTP)
// still counts as "running".
let _dashboardSpawning = false;
let _dashboardChildPid = null;

function _portIsListening(port, timeoutMs = 200) {
  return new Promise((resolve) => {
    import('node:net').then(({ createConnection }) => {
      let settled = false;
      const sock = createConnection({ host: '127.0.0.1', port });
      const done = (ok) => {
        if (settled) return;
        settled = true;
        try { sock.destroy(); } catch {}
        resolve(ok);
      };
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
      setTimeout(() => done(false), timeoutMs);
    }).catch(() => resolve(false));
  });
}

async function _dashboardProbe(port) {
  // Fast path — port-level probe. Catches a daemon that has bound the
  // socket but hasn't finished initializing its HTTP routes.
  if (await _portIsListening(port, 200)) return true;
  // Slow path — full /healthz fetch, for defense in depth.
  if (typeof fetch !== 'function') return false;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 250);
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: ac.signal });
    clearTimeout(t);
    return !!(r && r.ok);
  } catch { return false; }
}

function _openBrowser(url) {
  return import('node:child_process').then(({ spawn }) => {
    let cmd, args;
    if (process.platform === 'darwin')      { cmd = 'open';     args = [url]; }
    else if (process.platform === 'win32')  { cmd = 'cmd';      args = ['/c', 'start', '""', url]; }
    else                                    { cmd = 'xdg-open'; args = [url]; }
    try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* swallow */ }
  });
}

async function _dashboardStop(port) {
  // Best-effort kill of every lazyclaw dashboard daemon on the box.
  // Used to clean up after the v5.4.3 spawn pile-up bug.
  if (process.platform === 'win32') {
    return 'dashboard stop: not implemented on Windows yet — kill via Task Manager';
  }
  const { spawn } = await import('node:child_process');
  // Step 1: lsof the port and SIGTERM each PID.
  const portPids = await new Promise((resolve) => {
    try {
      const lsof = spawn('lsof', ['-ti', `tcp:${port}`], { stdio: ['ignore', 'pipe', 'ignore'] });
      let buf = '';
      lsof.stdout.on('data', (d) => { buf += d.toString('utf8'); });
      lsof.on('error', () => resolve([]));
      lsof.on('close', () => resolve(
        buf.trim().split(/\s+/).map((s) => parseInt(s, 10)).filter(Number.isFinite)
      ));
    } catch { resolve([]); }
  });
  for (const pid of portPids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  }
  // Step 2: pkill any process whose command line includes "lazyclaw dashboard"
  // — catches detached children that bound a different (random) port via
  // cmdDashboard's EADDRINUSE fallback.
  let pkilled = 0;
  try {
    const pkill = spawn('pkill', ['-f', 'lazyclaw dashboard'], { stdio: ['ignore', 'ignore', 'ignore'] });
    pkilled = await new Promise((r) => pkill.on('close', (code) => r(code === 0 ? 1 : 0)));
  } catch { /* fine */ }
  _dashboardChildPid = null;
  return `✓ stopped ${portPids.length} listener(s) on :${port}${pkilled ? ' + remaining `lazyclaw dashboard` processes via pkill' : ''}`;
}

// Parse the daemon's "listening at <url>" stdout line so /dashboard opens the
// actually-bound port (the child may fall back to a random port on EADDRINUSE).
export function parseDashboardUrl(text) {
  const m = String(text || '').match(/listening at\s+(https?:\/\/\S+)/i);
  return m ? m[1] : null;
}

// Resolve the daemon's real URL from its stdout within `timeoutMs`, or null.
function _waitForDashboardUrl(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || !child.stdout) { resolve(null); return; }
    let buf = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { child.stdout.off('data', onData); } catch { /* ignore */ }
      resolve(v);
    };
    const onData = (d) => {
      buf += d.toString('utf8');
      const u = parseDashboardUrl(buf);
      if (u) finish(u);
    };
    child.stdout.on('data', onData);
    setTimeout(() => finish(null), timeoutMs);
  });
}

export async function _dashboard(args) {
  const port = 19600;
  const url = `http://127.0.0.1:${port}/dashboard`;
  // Under the node:test runner, never launch a real daemon or open a browser
  // (it leaked a background daemon + opened a tab on every test run).
  if (process.env.NODE_TEST_CONTEXT) return `dashboard: ${url} (spawn skipped under test)`;
  const sub = splitWhitespace(args)[0];
  if (sub === 'stop' || sub === 'kill') return _dashboardStop(port);

  // 1. Already running anywhere on the machine? → reuse.
  if (await _dashboardProbe(port)) {
    await _openBrowser(url);
    return `✓ dashboard already running — opened ${url}`;
  }

  // 2. We spawned in this chat — is that child still alive?
  if (_dashboardChildPid != null) {
    try {
      process.kill(_dashboardChildPid, 0); // signal 0 = liveness probe
      // Child alive but not answering yet. Don't re-spawn; just nudge.
      await _openBrowser(url);
      return `✓ dashboard starting (pid ${_dashboardChildPid}) — opened ${url}`;
    } catch {
      _dashboardChildPid = null; // child died; fall through and respawn.
    }
  }

  // 3. Spawn already in flight from a concurrent /dashboard? Don't pile on.
  if (_dashboardSpawning) {
    await _openBrowser(url);
    return `dashboard is still booting — opened ${url}; try again in a moment if it didn't load`;
  }

  // 4. Cold start. Spawn ONE detached child, poll up to 3s, latch the
  //    spawn flag in a finally so it always clears.
  _dashboardSpawning = true;
  try {
    const { spawn } = await import('node:child_process');
    let child;
    try {
      // Pass --port so the child tries 19600 first; pipe stdout so we can read
      // the real bound URL (it may fall back to a random port on EADDRINUSE).
      child = spawn(process.execPath, [process.argv[1], 'dashboard', '--port', String(port), '--no-open'], {
        detached: true, stdio: ['ignore', 'pipe', 'ignore'], cwd: process.cwd(), env: process.env,
      });
      _dashboardChildPid = child.pid;
    } catch (e) {
      return `dashboard error: failed to spawn — ${e?.message || e}`;
    }
    // Prefer the daemon's own "listening at <url>" line — it carries the
    // actual port even after a random-port fallback.
    const boundUrl = await _waitForDashboardUrl(child, 3000);
    // Release the captured stdout pipe so the detached daemon doesn't keep
    // OUR event loop alive (unref, not destroy — destroying would EPIPE the
    // daemon on its next stdout write). Then unref the child itself.
    try { if (child.stdout) { child.stdout.removeAllListeners('data'); child.stdout.unref(); } } catch { /* ignore */ }
    child.unref();
    if (boundUrl) {
      await _openBrowser(boundUrl);
      return `✓ started dashboard (pid ${child.pid}) — opened ${boundUrl}`;
    }
    // Fallback: the line never arrived — poll the default port best-effort.
    const start = Date.now();
    while (Date.now() - start < 1500) {
      if (await _dashboardProbe(port)) {
        await _openBrowser(url);
        return `✓ started dashboard (pid ${child.pid}) — opened ${url}`;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return `⚠ dashboard didn't come up within 3s (pid ${child.pid}). URL: ${url}`;
  } finally {
    _dashboardSpawning = false;
  }
}
