// tests/f-gateway-guard.test.mjs — Phase 1 of the always-on gateway:
// boot-time security fail-closed guards + crash handlers for long-running
// (daemon / channel listener) processes.
//
// Why these exist:
//   - assertUnattendedSafe: `security.allowUnattendedSensitive` is a GLOBAL
//     flag read by tool_runner for EVERY tool call. An always-on channel /
//     daemon surface combined with that flag = remote-message-to-bash (RCE).
//     We refuse to boot a remote inbound surface while it is set.
//   - assertServicePairing: an unattended service with an empty pairing
//     allowlist answers anyone who can reach it, 24/7. Refuse it.
//   - installCrashHandlers: there are ZERO process-level crash handlers in
//     the codebase, so a single unhandledRejection silently kills the
//     always-on process with no log and no clean socket shutdown.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GatewayGuardError,
  assertUnattendedSafe,
  assertServicePairing,
  installCrashHandlers,
} from '../lib/gateway_guard.mjs';

// assert.throws() returns undefined, so capture the thrown error to inspect
// its .code/.message.
function caught(fn) {
  try { fn(); } catch (e) { return e; }
  return null;
}

test('assertUnattendedSafe: throws when allowUnattendedSensitive===true', () => {
  const err = caught(() => assertUnattendedSafe({ security: { allowUnattendedSensitive: true } }, { surface: 'slack' }));
  assert.ok(err instanceof GatewayGuardError);
  assert.equal(err.code, 'UNATTENDED_SENSITIVE_WITH_CHANNEL');
  assert.match(err.message, /slack/);
});

test('assertUnattendedSafe: no-op for absent / false flag', () => {
  for (const cfg of [undefined, null, {}, { security: {} }, { security: { allowUnattendedSensitive: false } }]) {
    assert.doesNotThrow(() => assertUnattendedSafe(cfg, { surface: 'daemon' }));
  }
});

test('assertServicePairing: throws in service mode with empty pairing', () => {
  for (const cfg of [undefined, {}, { pairing: [] }, { pairing: [{}] }]) {
    const err = caught(() => assertServicePairing(cfg, { service: true, surface: 'telegram' }));
    assert.ok(err instanceof GatewayGuardError, `expected throw for ${JSON.stringify(cfg)}`);
    assert.equal(err.code, 'SERVICE_REQUIRES_PAIRING');
  }
});

test('assertServicePairing: no-op when not service mode, or when paired', () => {
  assert.doesNotThrow(() => assertServicePairing({ pairing: [] }, { service: false }));
  assert.doesNotThrow(() => assertServicePairing({ pairing: [{ id: '123' }] }, { service: true }));
});

test('installCrashHandlers: registers both handlers, is idempotent, cleans up', () => {
  const before = {
    rej: process.listenerCount('unhandledRejection'),
    exc: process.listenerCount('uncaughtException'),
  };
  const cleanup1 = installCrashHandlers({ label: 'test', exit: () => {} });
  assert.equal(process.listenerCount('unhandledRejection'), before.rej + 1);
  assert.equal(process.listenerCount('uncaughtException'), before.exc + 1);

  // Idempotent: a second install must not add more listeners and must
  // return the same cleanup.
  const cleanup2 = installCrashHandlers({ label: 'test', exit: () => {} });
  assert.equal(process.listenerCount('unhandledRejection'), before.rej + 1);
  assert.equal(cleanup2, cleanup1);

  cleanup1();
  assert.equal(process.listenerCount('unhandledRejection'), before.rej);
  assert.equal(process.listenerCount('uncaughtException'), before.exc);
});

test('installCrashHandlers: installed handler logs, stops, and exits(1)', async () => {
  const logged = [];
  const stopped = [];
  const exited = [];
  const cleanup = installCrashHandlers({
    label: 'gw',
    logger: { error: (msg, detail) => logged.push({ msg, detail }) },
    stop: async () => { stopped.push(true); },
    exit: (code) => { exited.push(code); },
  });
  try {
    // Grab the handler we just registered and drive it directly (calling it
    // does NOT crash the process — exit is stubbed).
    const handler = process.listeners('uncaughtException').at(-1);
    await handler(new Error('boom'));
    assert.equal(logged.length, 1);
    assert.match(logged[0].detail.error, /boom/);
    assert.deepEqual(stopped, [true]);
    assert.deepEqual(exited, [1]);
  } finally {
    cleanup();
  }
});
