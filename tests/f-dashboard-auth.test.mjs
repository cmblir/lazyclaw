// f-dashboard-auth — the web dashboard must work against an auth-token
// daemon. Two gaps pinned here:
//   (a) web/dashboard.js api()/apiSoft() helpers sent a bare fetch() with no
//       Authorization header, so every JSON call got 401 with no recovery.
//   (b) the auth gate sat ahead of the static dashboard routes, so the
//       browser couldn't even load the page to enter a token.
//
// Fix: static dashboard shell (HTML/CSS/JS, no secrets) bypasses the token
// gate; the JSON API stays gated; the browser attaches a bearer token from
// localStorage and prompts once on 401.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { isAuthorized, isStaticDashboardPath } from '../daemon/lib/auth.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DASHBOARD_JS = path.join(HERE, '..', 'web', 'dashboard.js');

// ── (b) auth allowlist ──────────────────────────────────────────────
test('isStaticDashboardPath allows exactly the static shell routes', () => {
  for (const p of ['/', '/dashboard', '/dashboard/', '/dashboard.css', '/dashboard.js']) {
    assert.equal(isStaticDashboardPath(p), true, `${p} should be allowed`);
  }
  // Data / mutation routes are NOT static.
  for (const p of ['/config', '/sessions', '/config/provider', '/agent', '/dashboard.html', '/dashboardx']) {
    assert.equal(isStaticDashboardPath(p), false, `${p} should not be allowed`);
  }
});

test('static dashboard paths bypass the token check; data routes still require it', () => {
  const token = 'sekret-token';
  // Static shell: no Authorization header, but authorized because the path
  // is on the allowlist.
  const staticReq = { method: 'GET', url: '/dashboard', headers: {} };
  assert.equal(isAuthorized(staticReq, token), true);

  // Data route with no token -> rejected.
  const dataReq = { method: 'GET', url: '/config', headers: {} };
  assert.equal(isAuthorized(dataReq, token), false);

  // Data route with the correct bearer -> allowed.
  const dataReqOk = { method: 'GET', url: '/config', headers: { authorization: `Bearer ${token}` } };
  assert.equal(isAuthorized(dataReqOk, token), true);
});

test('static bypass does not weaken mutation routes (POST/PUT/DELETE)', () => {
  const token = 'sekret-token';
  // A mutation never matches a static GET path, but assert the bypass is
  // GET-only so a crafted method can't ride the allowlist.
  const mutate = { method: 'POST', url: '/dashboard', headers: {} };
  assert.equal(isAuthorized(mutate, token), false);
});

test('dot-segment traversal cannot ride the static bypass to a data route', () => {
  const token = 'sekret-token';
  // `/dashboard/../config` normalizes to `/config` (a gated data route).
  const sneaky = { method: 'GET', url: '/dashboard/../config', headers: {} };
  assert.equal(isAuthorized(sneaky, token), false);
});

test('no token configured -> everything is authorized (loopback default)', () => {
  const req = { method: 'POST', url: '/config/provider', headers: {} };
  assert.equal(isAuthorized(req, ''), true);
});

// ── (a) dashboard.js source-level ───────────────────────────────────
test('dashboard.js api helper attaches a bearer token from localStorage', () => {
  const src = fs.readFileSync(DASHBOARD_JS, 'utf8');
  // Reads/stores the token under the agreed localStorage key.
  assert.match(src, /lazyclaw_token/, 'should reference the lazyclaw_token localStorage key');
  assert.match(src, /localStorage\.getItem/, 'should read the token from localStorage');
  assert.match(src, /localStorage\.setItem/, 'should persist the token to localStorage');
  // Sends an Authorization: Bearer header when a token is known.
  assert.match(src, /Authorization/, 'should set an Authorization header');
  assert.match(src, /Bearer /, 'should use the Bearer scheme');
  // Prompts the user once and retries on 401.
  assert.match(src, /401/, 'should detect a 401 to trigger the token prompt');
});

test('every dashboard request routes through the auth-aware fetch (no bare fetch bypasses auth)', () => {
  const src = fs.readFileSync(DASHBOARD_JS, 'utf8');
  // The ONLY place allowed to call fetch directly is apiRaw, via
  // globalThis.fetch. Any other `fetch(` (export/delete/test/POST call
  // sites) would bypass the Authorization header and 401 on a token daemon.
  const bareFetch = (src.match(/(?<!globalThis\.)\bfetch\(/g) || []).length;
  assert.equal(bareFetch, 0, 'no bare fetch( may bypass apiRaw; all calls must route through apiRaw/globalThis.fetch');
  assert.match(src, /async function apiRaw\(/, 'apiRaw is the single auth-aware fetch primitive');
});
