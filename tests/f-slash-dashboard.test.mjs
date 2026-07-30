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

test('a --port value outside the 16-bit port range is rejected sensibly, falling back to config', async () => {
  const out = await _dashboard('--port 99999', { cfg: { dashboard: { port: 19601 } } });
  assert.match(out, /:19601\/dashboard/);
});

test('a non-numeric --port value is rejected sensibly, falling back to the default', async () => {
  const out = await _dashboard('--port notanumber', {});
  assert.match(out, /:19600\/dashboard/);
});

test('the stop subcommand still parses (and stays test-safe: no real kill/spawn runs)', async () => {
  const out = await _dashboard('stop', { cfg: { dashboard: { port: 19601 } } });
  // Under NODE_TEST_CONTEXT the function returns before reaching
  // _dashboardStop, so this just pins that adding ctx/port parsing didn't
  // break the stop/kill argument path.
  assert.match(out, /:19601\/dashboard/);
});
