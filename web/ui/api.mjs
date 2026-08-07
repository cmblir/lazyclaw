// web/ui/api.mjs — auth-token storage and the fetch primitives every panel
// routes its requests through. Moved verbatim out of dashboard.js; bodies
// are unchanged.

// ── Auth token ────────────────────────────────────────────────
// The static dashboard shell is served without a token, but the JSON
// API stays gated when the daemon runs with --auth-token. We keep the
// token in localStorage and attach it as `Authorization: Bearer` on
// every API call. A loopback daemon with no auth never sends a token —
// the header is simply absent and calls work unchanged.
// The key was `lazyclaw_token` before the rename, and it lives in the browser
// rather than in a file we control — so unlike the config directory, we cannot
// look at what is there and adopt it. An operator who already pasted their token
// would simply be logged out by a bare rename. Reading falls back to the old key
// and copies the value forward; the old key is left in place, since deleting it
// gains nothing and forfeits the only path back.
const TOKEN_KEY = 'pompos_token';
const LEGACY_TOKEN_KEY = 'lazyclaw_token';
export function getToken() {
  try {
    const current = localStorage.getItem(TOKEN_KEY);
    if (current) return current;
    const legacy = localStorage.getItem(LEGACY_TOKEN_KEY);
    if (legacy) { setToken(legacy); return legacy; }
    return '';
  } catch { return ''; }
}
export function setToken(t) {
  try { localStorage.setItem(TOKEN_KEY, t); } catch {}
}
// Merge an Authorization header into the caller's opts when a token is
// known, without clobbering any other headers they passed.
export function withAuth(opts = {}) {
  const token = getToken();
  if (!token) return opts;
  return { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } };
}
// On 401 from a gated route, prompt the user once for the token, store
// it, and signal the caller to retry. window.prompt is fine for v1.
export function promptForToken() {
  const entered = window.prompt(
    'This daemon requires an auth token (started with --auth-token).\n' +
    'Paste the token to continue:',
    getToken(),
  );
  if (entered == null) return false; // user cancelled
  setToken(entered.trim());
  return true;
}

// Single auth-aware fetch primitive: adds the bearer token via withAuth,
// prompts for a token + retries once on 401, returns the raw Response.
// ALL dashboard requests route through this (api/apiSoft + the direct
// export/delete/test/POST call sites) so none bypass the auth gate. Uses
// globalThis.fetch so this is the only place that touches fetch directly.
export async function apiRaw(path, opts = {}) {
  let r = await globalThis.fetch(path, withAuth(opts));
  if (r.status === 401 && promptForToken()) {
    r = await globalThis.fetch(path, withAuth(opts)); // retry once with the new token
  }
  return r;
}
// Tiny fetch helper that surfaces errors as toasts on the page.
export async function api(path, opts = {}) {
  const r = await apiRaw(path, opts);
  if (!r.ok && r.status !== 200) {
    // Surface the server's human-readable `error` string only — never the
    // raw JSON envelope or an internal error code (e.g. TEAM_BAD_AGENT).
    let msg = '';
    try { const b = await r.json(); if (b && typeof b.error === 'string') msg = b.error; } catch {}
    throw new Error(msg || `${r.status} ${r.statusText}`);
  }
  return r.json();
}
// Soft variant: returns { status, body } no matter what — used by the
// /doctor (503 on issues), /rates/validate (422), /config/validate (422)
// endpoints where a non-200 carries a meaningful payload, not an error.
export async function apiSoft(path, opts = {}) {
  const r = await apiRaw(path, opts);
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, ok: r.ok, body };
}
