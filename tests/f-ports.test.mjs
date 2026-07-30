// tests/f-ports.test.mjs — lib/ports.mjs: the single port resolver that
// replaced five independent `19600` literals (commands/gateway.mjs,
// commands/daemon.mjs's cmdDashboard, commands/service.mjs x2,
// tui/slash_dashboard.mjs). Precedence is flag > config > default; backward
// compatibility (an untouched config still yields 19600 everywhere) is
// pinned explicitly since it's the hard requirement of the feature.

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PORT, resolvePort, configuredPort, isValidPort, InvalidPortError } from '../lib/ports.mjs';

test('DEFAULT_PORT is the historical hardcoded value', () => {
  assert.equal(DEFAULT_PORT, 19600);
});

test('isValidPort: integers 1024-65535 only', () => {
  assert.equal(isValidPort(19600), true);
  assert.equal(isValidPort(1024), true);
  assert.equal(isValidPort(65535), true);
  assert.equal(isValidPort(1023), false);
  assert.equal(isValidPort(65536), false);
  assert.equal(isValidPort(0), false);
  assert.equal(isValidPort(-1), false);
  assert.equal(isValidPort(80.5), false);
  assert.equal(isValidPort(NaN), false);
});

// ---- backward compatibility: the hard requirement ----

test('backward compat: an empty config yields 19600 for all three surfaces', () => {
  assert.equal(resolvePort('gateway', {}, {}), DEFAULT_PORT);
  assert.equal(resolvePort('dashboard', {}, {}), DEFAULT_PORT);
  assert.equal(resolvePort('daemon', {}, {}), DEFAULT_PORT);
});

test('backward compat: a config with unrelated keys (no port sections) still yields 19600', () => {
  const cfg = { provider: 'mock', channels: { slack: { enabled: true } } };
  assert.equal(resolvePort('gateway', {}, cfg), DEFAULT_PORT);
  assert.equal(resolvePort('dashboard', {}, cfg), DEFAULT_PORT);
  assert.equal(resolvePort('daemon', {}, cfg), DEFAULT_PORT);
});

test('backward compat: no flags object and no cfg object at all', () => {
  assert.equal(resolvePort('gateway'), DEFAULT_PORT);
  assert.equal(resolvePort('dashboard', undefined, undefined), DEFAULT_PORT);
});

// ---- precedence: flag > config > default ----

test('precedence: an explicit --port flag wins over config', () => {
  const cfg = { gateway: { port: 5001 } };
  assert.equal(resolvePort('gateway', { port: 6001 }, cfg), 6001);
});

test('precedence: config wins over the default when no flag is given', () => {
  assert.equal(resolvePort('gateway', {}, { gateway: { port: 5001 } }), 5001);
  assert.equal(resolvePort('dashboard', {}, { dashboard: { port: 5002 } }), 5002);
  assert.equal(resolvePort('daemon', {}, { daemon: { port: 5003 } }), 5003);
});

test('precedence: a surface-scoped section wins for its own surface, others fall to default', () => {
  // A user moving ONLY the dashboard off a collision must not shift gateway/daemon.
  const cfg = { dashboard: { port: 19601 } };
  assert.equal(resolvePort('dashboard', {}, cfg), 19601);
  assert.equal(resolvePort('gateway', {}, cfg), DEFAULT_PORT);
  assert.equal(resolvePort('daemon', {}, cfg), DEFAULT_PORT);
});

test('flags.port as a string (as parsed CLI argv delivers it) still resolves', () => {
  assert.equal(resolvePort('gateway', { port: '7000' }, {}), 7000);
});

// `runGateway({ port: 0 }, ...)` is a real call shape (tests/f-gateway-e2e
// .test.mjs and the EADDRINUSE random-port fallbacks): 0 is Node's "let the
// OS assign an ephemeral port" sentinel, not a garbage value. resolvePort
// must pass it through rather than treating it as invalid and falling back
// to config/default — that regression would silently rebind the well-known
// port and reintroduce the exact collision this feature exists to prevent.
test('an explicit --port 0 (ephemeral-port sentinel) passes through unchanged', () => {
  assert.equal(resolvePort('gateway', { port: 0 }, { gateway: { port: 5001 } }), 0);
  assert.equal(resolvePort('gateway', { port: 0 }, {}), 0);
});

// An explicit flag is honored even below the persisted-config floor of 1024
// — the operator asked for it directly, unlike a value merely sitting in
// config.json. This matches the zero validation the five replaced call
// sites used to apply to their own --port flag.
test('an explicit low (privileged-range) --port flag is still honored, unlike a config value', () => {
  assert.equal(resolvePort('gateway', { port: 80 }, {}), 80);
});

// ---- missing / partial config ----

test('partial config: only the surface being resolved is read, siblings are ignored', () => {
  const cfg = { gateway: { port: 5001 }, dashboard: { port: 5002 } };
  assert.equal(resolvePort('daemon', {}, cfg), DEFAULT_PORT);
});

test('a surface section present but with no port key falls back to default', () => {
  assert.equal(resolvePort('gateway', {}, { gateway: {} }), DEFAULT_PORT);
});

// ---- invalid values rejected sensibly ----
//
// Fix round 1: a PRESENT --port that fails to parse used to fall through to
// config/default silently — "the port you asked for quietly didn't take
// effect" is exactly the failure this feature exists to eliminate (it's just
// as bad as the original shared-19600 collision, only one abstraction layer
// deeper). Before this resolver existed, a bad --port reached
// server.listen() and Node threw ERR_SOCKET_BAD_PORT — loud and immediate.
// A PRESENT-but-invalid flag must now throw InvalidPortError instead of
// falling through. An ABSENT flag (the key simply not set) is unaffected —
// that still falls through to config, then the default. Do not "simplify"
// the throw back into a fallthrough.

test('an ABSENT flag (key not set) still falls through to config, then default — unchanged', () => {
  assert.equal(resolvePort('gateway', {}, { gateway: { port: 5001 } }), 5001);
  assert.equal(resolvePort('gateway', {}, {}), DEFAULT_PORT);
  assert.equal(resolvePort('gateway', undefined, { gateway: { port: 5001 } }), 5001);
});

test('a PRESENT non-numeric flag throws InvalidPortError instead of falling through', () => {
  const cfg = { gateway: { port: 5001 } };
  assert.throws(() => resolvePort('gateway', { port: 'not-a-number' }, cfg), InvalidPortError);
  assert.throws(() => resolvePort('gateway', { port: 'garbage' }, {}), InvalidPortError);
});

test('a PRESENT empty-string flag throws InvalidPortError instead of falling through', () => {
  assert.throws(() => resolvePort('gateway', { port: '' }, { gateway: { port: 5001 } }), InvalidPortError);
});

test('a PRESENT flag outside the 16-bit port range throws InvalidPortError instead of falling through', () => {
  const cfg = { gateway: { port: 5001 } };
  assert.throws(() => resolvePort('gateway', { port: 99999 }, cfg), InvalidPortError);
  assert.throws(() => resolvePort('gateway', { port: -5 }, cfg), InvalidPortError);
  assert.throws(() => resolvePort('gateway', { port: -1 }, cfg), InvalidPortError);
});

test('InvalidPortError names the surface, the offending value, and the accepted range', () => {
  try {
    resolvePort('gateway', { port: 'abc' }, {});
    assert.fail('expected resolvePort to throw');
  } catch (err) {
    assert.ok(err instanceof InvalidPortError);
    assert.ok(err instanceof RangeError, 'InvalidPortError must be a RangeError');
    assert.match(err.message, /gateway/);
    assert.match(err.message, /"abc"/);
    assert.match(err.message, /0.*65535/);
    assert.equal(err.surface, 'gateway');
    assert.equal(err.value, 'abc');
  }
});

test('--port 0 (ephemeral-port sentinel) still resolves, not thrown — regression guard', () => {
  assert.equal(resolvePort('gateway', { port: 0 }, { gateway: { port: 5001 } }), 0);
  assert.equal(resolvePort('gateway', { port: '0' }, {}), 0);
});

test('out-of-range or non-numeric CONFIG value (no flag involved) is ignored, falling to the default', () => {
  assert.equal(resolvePort('gateway', {}, { gateway: { port: 99999 } }), DEFAULT_PORT);
  assert.equal(resolvePort('gateway', {}, { gateway: { port: 'abc' } }), DEFAULT_PORT);
  assert.equal(resolvePort('gateway', {}, { gateway: { port: 80 } }), DEFAULT_PORT);
});

test('an unknown surface throws rather than silently resolving', () => {
  assert.throws(() => resolvePort('bogus', {}, {}), /unknown surface/);
});

// ---- configuredPort: the raw "what does config say" query ----

test('configuredPort returns null when the surface section is absent', () => {
  assert.equal(configuredPort('gateway', {}), null);
  assert.equal(configuredPort('gateway', { dashboard: { port: 5002 } }), null);
});

test('configuredPort returns the configured value when valid', () => {
  assert.equal(configuredPort('gateway', { gateway: { port: 5001 } }), 5001);
});

test('configuredPort returns null for an invalid value instead of propagating it', () => {
  assert.equal(configuredPort('gateway', { gateway: { port: 'nope' } }), null);
  assert.equal(configuredPort('gateway', { gateway: { port: 99999 } }), null);
  assert.equal(configuredPort('gateway', { gateway: { port: 80 } }), null);
});
