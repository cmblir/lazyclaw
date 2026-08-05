// tests/f-dashboard-ui-auth.test.mjs — the static-shell allowlist is what lets
// the dashboard load without a token, so widening it for ES modules is security
// code. These cases pin the boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isStaticDashboardPath, isAuthorized } from '../daemon/lib/auth.mjs';

test('ui module paths are on the static allowlist', () => {
  for (const p of ['/ui/dom.mjs', '/ui/shell.mjs', '/ui/panels/chat.mjs', '/ui/team_tree.mjs']) {
    assert.equal(isStaticDashboardPath(p), true, `${p} should be allowed`);
  }
});

test('ui allowlist refuses anything that is not a plain lowercase module path', () => {
  const bad = [
    '/ui/../config',            // traversal
    '/ui/Dom.mjs',              // uppercase
    '/ui/dom.js',               // wrong extension
    '/ui/a/b/c.mjs',            // deeper than one nested dir
    '/ui/dom.mjs.map',          // extra extension
    '/ui/',                     // directory
    '/ui/.env.mjs',             // leading dot
    '/uix/dom.mjs',             // prefix confusion
    '/ui/dom%2emjs',            // encoded dot
  ];
  for (const p of bad) {
    assert.equal(isStaticDashboardPath(p), false, `${p} must NOT be allowed`);
  }
});

test('the existing allowlist and its refusals are unchanged', () => {
  for (const p of ['/', '/dashboard', '/dashboard/', '/dashboard.css', '/dashboard.js']) {
    assert.equal(isStaticDashboardPath(p), true);
  }
  for (const p of ['/config', '/sessions', '/dashboard.html', '/dashboardx']) {
    assert.equal(isStaticDashboardPath(p), false);
  }
});

test('a ui module bypasses the token gate on GET but never on POST', () => {
  const token = 'secret-token';
  assert.equal(isAuthorized({ method: 'GET', url: '/ui/dom.mjs', headers: {} }, token), true);
  assert.equal(isAuthorized({ method: 'POST', url: '/ui/dom.mjs', headers: {} }, token), false);
});

test('a dot-segment cannot ride the ui bypass into a gated route', () => {
  const token = 'secret-token';
  // Normalizes to /config, which is not on the allowlist.
  assert.equal(isAuthorized({ method: 'GET', url: '/ui/../config', headers: {} }, token), false);
});
