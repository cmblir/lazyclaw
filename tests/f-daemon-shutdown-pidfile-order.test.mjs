// tests/f-daemon-shutdown-pidfile-order.test.mjs — pins the ordering of
// removePidfile() vs. the graceful-shutdown await inside cmdDaemon's
// `shutdown` handler in commands/daemon.mjs.
//
// cmdDaemon binds a real port and installs real SIGINT/SIGTERM handlers, so
// it cannot be driven end-to-end from a unit test without flakiness. The
// property that matters here is purely about ORDER of two statements inside
// a closure, not runtime behaviour that could be observed any other way
// short of racing real OS signals against a real graceful-shutdown window —
// so a source-level assertion is the honest way to pin it (and cheaper/more
// reliable than trying to fake that race).
//
// Why the order matters: a second SIGINT/SIGTERM arriving while the first
// shutdown is still awaiting gracefulShutdown() hits the early-return
// `shuttingDown` branch and calls process.exit(1) immediately — it never
// reaches any code after the await. If removePidfile() runs only after that
// await, this second-signal path leaks daemon.pid, and the next
// `lazyclaw daemon status` reports a dead daemon as running until something
// else cleans it up. Moving removePidfile() before the await (mirroring
// commands/gateway.mjs's onSig, which already does removePidfile() before
// `await gw.stop()`) closes that window: the pidfile is gone the moment
// shutdown is committed to, regardless of how many more signals arrive.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'commands', 'daemon.mjs'), 'utf8');

test('cmdDaemon shutdown: removePidfile() runs before awaiting gracefulShutdown', () => {
  const cmdDaemonStart = SRC.indexOf('export async function cmdDaemon');
  assert.notEqual(cmdDaemonStart, -1, 'cmdDaemon not found in commands/daemon.mjs');
  const cmdDaemonSrc = SRC.slice(cmdDaemonStart);

  // Scope to the `shutdown` closure specifically (not the installCrashHandlers
  // `stop:` callback a few lines above it, which already gets this order
  // right and must not be touched by this test).
  const shutdownStart = cmdDaemonSrc.indexOf('const shutdown = async () => {');
  assert.notEqual(shutdownStart, -1, 'shutdown handler not found inside cmdDaemon');
  const shutdownBody = cmdDaemonSrc.slice(shutdownStart);

  const removeIdx = shutdownBody.indexOf('removePidfile()');
  const awaitIdx = shutdownBody.indexOf('await gracefulShutdown');
  assert.notEqual(removeIdx, -1, 'removePidfile() call not found in the shutdown handler');
  assert.notEqual(awaitIdx, -1, 'await gracefulShutdown call not found in the shutdown handler');

  assert.ok(
    removeIdx < awaitIdx,
    'removePidfile() must be called BEFORE awaiting gracefulShutdown in cmdDaemon\'s shutdown ' +
    'handler. A second SIGINT/SIGTERM arriving during the graceful-shutdown window takes the ' +
    'early "already shuttingDown" branch and calls process.exit(1) directly, without ever running ' +
    'code after the await — so if removePidfile() sits after the await, that second-signal path ' +
    'leaks daemon.pid and `lazyclaw daemon status` will report a dead daemon as running.'
  );
});
