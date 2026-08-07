// Auth-token + origin gate helpers for the daemon. Pure — used only by
// the pre-switch middleware in makeHandler.

/**
 * Constant-time string equality. Plain `===` would short-circuit on the
 * first mismatching byte, leaking timing info that lets an attacker on
 * a shared host narrow the secret one byte at a time. We compare every
 * byte with XOR + accumulator.
 */
export function constantTimeEqual(a, b) {
  const aStr = String(a ?? '');
  const bStr = String(b ?? '');
  if (aStr.length !== bStr.length) return false;
  let diff = 0;
  for (let i = 0; i < aStr.length; i++) {
    diff |= aStr.charCodeAt(i) ^ bStr.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Static dashboard shell allowlist. The HTML/CSS/JS that make up the
 * dashboard contain no secrets — they're an empty shell that fetches every
 * piece of data over the (still token-gated) JSON API. Serving the shell
 * without a token lets the browser load the page and obtain the token from
 * the user; the bearer check then guards every data/mutation route. The
 * list is the EXACT set of static GET routes (see daemon/route_table.mjs);
 * no prefixes, so a route like `/dashboard.html` or `/config` never matches.
 */
const STATIC_DASHBOARD_PATHS = new Set([
  '/', '/dashboard', '/dashboard/', '/dashboard.css', '/dashboard.js',
]);

/**
 * The dashboard shell is ES modules under web/ui/, so the static allowlist
 * needs a shape as well as an exact set. Deliberately narrow: lowercase
 * ASCII, digits, `_` and `-` only, at most ONE nested directory, and a
 * literal `.mjs` tail. That admits `/ui/shell.mjs` and `/ui/panels/chat.mjs`
 * while refusing `..`, encoded dots, uppercase, and any second extension.
 * isAuthorized normalizes the URL before calling us, so `/ui/../config` has
 * already become `/config` by the time it gets here.
 */
const UI_MODULE_RE = /^\/ui\/(?:[a-z0-9_-]+\/)?[a-z0-9_-]+\.mjs$/;

export function isStaticDashboardPath(pathname) {
  return STATIC_DASHBOARD_PATHS.has(pathname) || UI_MODULE_RE.test(pathname);
}

export function isAuthorized(req, expectedToken) {
  if (!expectedToken) return true;  // auth disabled
  // Static dashboard shell bypasses the token gate (GET-only, no secrets).
  // Normalize the URL first so a dot-segment path like `/dashboard/../config`
  // can't ride the bypass into a gated data route — it normalizes to
  // `/config`, which isn't on the allowlist.
  if ((req.method || 'GET').toUpperCase() === 'GET') {
    let pathname = '';
    try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch { pathname = ''; }
    if (isStaticDashboardPath(pathname)) return true;
  }
  const header = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  return constantTimeEqual(m[1].trim(), expectedToken);
}

/**
 * Origin gate — protect against DNS-rebinding / CSRF where a page in
 * the user's browser posts to 127.0.0.1:<our port>. Browsers always
 * attach `Origin` for cross-origin POSTs (and increasingly for GETs);
 * CLI tools (curl, fetch from a script) usually don't.
 *
 * Policy:
 *   - No `Origin` header → assume non-browser caller, allow.
 *   - `Origin` set → must be in `allowedOrigins`. Empty allowlist
 *     means "reject all browser-originated requests" — the default,
 *     because the daemon is designed for CLI/script callers.
 *   - `allowLoopback: true` (set by `pompos dashboard`) additionally
 *     accepts any `Origin` that looks like loopback (`http://127.0.0.1:*`,
 *     `http://localhost:*`, `http://[::1]:*`). Safe because the daemon
 *     binds only to 127.0.0.1, so an attacker can't reach us with a
 *     loopback Origin unless they're already on the box. DNS rebinding
 *     can't forge `127.0.0.1` as a hostname — that resolves before
 *     `fetch()` ever issues the request.
 *
 * Returns true when the request should proceed, false when it should
 * be rejected with 403.
 */
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
export function isOriginAllowed(req, allowedOrigins, allowLoopback) {
  const origin = req.headers['origin'];
  if (!origin) return true;
  if (allowLoopback && LOOPBACK_ORIGIN_RE.test(origin)) return true;
  if (!allowedOrigins || allowedOrigins.length === 0) return false;
  return allowedOrigins.includes(origin);
}
