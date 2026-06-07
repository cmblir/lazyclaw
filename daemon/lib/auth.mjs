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

export function isAuthorized(req, expectedToken) {
  if (!expectedToken) return true;  // auth disabled
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
 *   - `allowLoopback: true` (set by `lazyclaw dashboard`) additionally
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
