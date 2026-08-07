// tests/p3-dashboard-url.test.mjs — /dashboard hard-coded port 19600 for the
// probe + opened URL, so when the spawned daemon fell back to a random port
// (EADDRINUSE), the chat opened a dead URL. cmdDashboard prints the real bound
// URL to stdout; parse it so we open the actual port.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDashboardUrl } from '../tui/slash_dispatcher.mjs';

test('parseDashboardUrl extracts the bound URL from the daemon stdout line', () => {
  const line = '🦞 Pompos dashboard listening at http://127.0.0.1:51234/dashboard\n';
  assert.equal(parseDashboardUrl(line), 'http://127.0.0.1:51234/dashboard');
});

test('parseDashboardUrl works on the default port too', () => {
  assert.equal(
    parseDashboardUrl('listening at http://127.0.0.1:19600/dashboard'),
    'http://127.0.0.1:19600/dashboard',
  );
});

test('parseDashboardUrl tolerates partial buffers / extra noise and returns null when absent', () => {
  assert.equal(parseDashboardUrl(''), null);
  assert.equal(parseDashboardUrl('booting...\nstill warming up'), null);
  // url spread is found even with leading noise
  assert.equal(
    parseDashboardUrl('warming\n🦞 Pompos dashboard listening at http://127.0.0.1:8080/dashboard\nready'),
    'http://127.0.0.1:8080/dashboard',
  );
});
