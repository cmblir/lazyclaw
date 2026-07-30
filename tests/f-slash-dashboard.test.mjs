// tests/f-slash-dashboard.test.mjs — /dashboard's port resolution.
// tui/slash_dashboard.mjs used to hardcode `const port = 19600`; it now
// routes through lib/ports.mjs's resolvePort('dashboard', flags, cfg) so a
// `--port <N>` override and `dashboard.port` in config.json both work, with
// 19600 preserved as the untouched-config default.
//
// Under node:test, NODE_TEST_CONTEXT is set automatically by the runner, and
// _dashboard's own guard (`if (process.env.NODE_TEST_CONTEXT) return ...`)
// short-circuits before any real spawn/probe/browser-open — so these tests
// never bind a real port or launch a real dashboard.

import test from 'node:test';
import assert from 'node:assert/strict';

import { _dashboard } from '../tui/slash_dashboard.mjs';

test('NODE_TEST_CONTEXT is set (sanity check for the no-real-spawn guard this file relies on)', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'expected the node:test runner to set this automatically');
});

test('backward compat: no ctx.cfg and no --port yields the historical 19600', async () => {
  const out = await _dashboard('', {});
  assert.match(out, /:19600\/dashboard/);
});

test('backward compat: a config with no dashboard section still yields 19600', async () => {
  const out = await _dashboard('', { cfg: { provider: 'mock', channels: {} } });
  assert.match(out, /:19600\/dashboard/);
});

test('cfg.dashboard.port is used when no --port flag is given', async () => {
  const out = await _dashboard('', { cfg: { dashboard: { port: 19601 } } });
  assert.match(out, /:19601\/dashboard/);
});

test('--port overrides cfg.dashboard.port (flag wins)', async () => {
  const out = await _dashboard('--port 6003', { cfg: { dashboard: { port: 19601 } } });
  assert.match(out, /:6003\/dashboard/);
});

test('--port overrides the default when no config is present', async () => {
  const out = await _dashboard('--port 6004', {});
  assert.match(out, /:6004\/dashboard/);
});

// Fix round 1: a present-but-invalid --port used to silently fall back to
// config/default (tested above as "rejected sensibly, falling back to
// config") — that's exactly the failure this feature exists to eliminate,
// just one layer deeper: the port you typed quietly didn't take effect.
// resolvePort now throws InvalidPortError for a PRESENT-but-invalid value;
// _dashboard must catch it and return a readable string (a slash handler
// must never throw — dispatchSlash does not wrap handlers in try/catch), and
// must NOT silently substitute the configured/default port instead.

test('a --port value outside the 16-bit port range is rejected with a readable message, not silently replaced', async () => {
  const out = await _dashboard('--port 99999', { cfg: { dashboard: { port: 19601 } } });
  assert.match(out, /invalid/i);
  assert.match(out, /99999/);
  assert.doesNotMatch(out, /19601/, 'must not silently substitute the configured port');
});

test('a non-numeric --port value is rejected with a readable message, not silently replaced', async () => {
  const out = await _dashboard('--port notanumber', {});
  assert.match(out, /invalid/i);
  assert.match(out, /notanumber/);
  assert.doesNotMatch(out, /19600/, 'must not silently substitute the default port');
});

test('--port 0 (ephemeral sentinel) is still accepted, not rejected as invalid', async () => {
  const out = await _dashboard('--port 0', { cfg: { dashboard: { port: 19601 } } });
  assert.match(out, /:0\/dashboard/);
});

test('an absent --port flag is unaffected by the throw-on-invalid change: still falls through to config, then default', async () => {
  assert.match(await _dashboard('', { cfg: { dashboard: { port: 19601 } } }), /:19601\/dashboard/);
  assert.match(await _dashboard('', {}), /:19600\/dashboard/);
});

// This does NOT exercise _dashboardStop — under NODE_TEST_CONTEXT, _dashboard
// returns before ever reading tokens[0], so "stop" is equivalent to any other
// string here. It only pins that the stop/kill token doesn't get mistaken
// for a --port value (e.g. an accidental off-by-one in the tokens array).
test('the literal "stop" argument does not disturb port parsing (stop itself is untested here — see module comment)', async () => {
  const out = await _dashboard('stop', { cfg: { dashboard: { port: 19601 } } });
  assert.match(out, /:19601\/dashboard/);
});
