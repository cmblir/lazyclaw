// f-dashboard-auth — the web dashboard must work against an auth-token
// daemon. Two gaps pinned here:
//   (a) the auth-aware fetch helpers (getToken/apiRaw/api/apiSoft) sent a
//       bare fetch() with no Authorization header, so every JSON call got
//       401 with no recovery.
//   (b) the auth gate sat ahead of the static dashboard routes, so the
//       browser couldn't even load the page to enter a token.
//
// Fix: static dashboard shell (HTML/CSS/JS, no secrets) bypasses the token
// gate; the JSON API stays gated; the browser attaches a bearer token from
// localStorage and prompts once on 401.
//
// (a) used to be checked against the single web/dashboard.js file. The
// dom/api/modal extraction (dashboard-shell-motion Task 1) moved the auth
// helpers into web/ui/api.mjs, and web/ui/ keeps growing — one panel module
// per later task, 30+ files by the end. So the source-level checks below
// target web/ui/api.mjs directly, and the bare-fetch scan walks every file
// under web/ui/ recursively (not just dashboard.js), so a bare fetch( added
// in any future panel still can't slip past this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { isAuthorized, isStaticDashboardPath } from '../daemon/lib/auth.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DASHBOARD_JS = path.join(HERE, '..', 'web', 'dashboard.js');
const API_MJS = path.join(HERE, '..', 'web', 'ui', 'api.mjs');
const UI_DIR = path.join(HERE, '..', 'web', 'ui');

// Recursively list every file under `dir` (web/ui/ is one file today, 30+
// once every panel moves out of dashboard.js — see the fetch-bypass test).
function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

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

test('isStaticDashboardPath also allows the dashboard shell ES modules under /ui/', () => {
  // web/ui/ is where the dom/api/modal extraction (Task 1) and later panel
  // modules live — the allowlist needs a shape, not just an exact set.
  for (const p of ['/ui/dom.mjs', '/ui/shell.mjs', '/ui/panels/chat.mjs']) {
    assert.equal(isStaticDashboardPath(p), true, `${p} should be allowed`);
  }
  for (const p of ['/ui/../config', '/ui/Dom.mjs', '/ui/dom.mjs.map', '/ui/a/b/c.mjs']) {
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

// ── (a) web/ui/api.mjs source-level ─────────────────────────────────
test('web/ui/api.mjs attaches a bearer token from localStorage', () => {
  const src = fs.readFileSync(API_MJS, 'utf8');
  // Reads/stores the token under the agreed localStorage key.
  assert.match(src, /lazyclaw_token/, 'should reference the lazyclaw_token localStorage key');
  assert.match(src, /localStorage\.getItem/, 'should read the token from localStorage');
  assert.match(src, /localStorage\.setItem/, 'should persist the token to localStorage');
  // Sends an Authorization: Bearer header when a token is known.
  assert.match(src, /Authorization/, 'should set an Authorization header');
  assert.match(src, /Bearer /, 'should use the Bearer scheme');
  // Prompts the user once and retries on 401.
  assert.match(src, /401/, 'should detect a 401 to trigger the token prompt');
  assert.match(src, /async function apiRaw\(/, 'apiRaw is the single auth-aware fetch primitive');
});

test('every dashboard request routes through the auth-aware fetch (no bare fetch bypasses auth)', () => {
  // The ONLY place allowed to call fetch directly is apiRaw, via
  // globalThis.fetch. Any other `fetch(` — in dashboard.js's panel loaders,
  // or in ANY file under web/ui/ (there will be 30+ once every panel moves
  // out) — would bypass the Authorization header and 401 on a token daemon.
  // Walk web/ui/ recursively so a panel added in a later task can't
  // introduce a bare fetch( unnoticed.
  const files = [DASHBOARD_JS, ...walkFiles(UI_DIR)];
  let bareFetch = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    bareFetch += (src.match(/(?<!globalThis\.)\bfetch\(/g) || []).length;
  }
  assert.equal(bareFetch, 0, 'no bare fetch( may bypass apiRaw; all calls must route through apiRaw/globalThis.fetch (checked across dashboard.js and web/ui/**)');
});
