// lib/ports.mjs — single resolver for the HTTP port each long-running surface
// (gateway / dashboard / the daemon-as-a-service) binds to. Replaces five
// independent `19600` literals that used to make dashboard / gateway / the
// installed daemon service collide by construction (commands/gateway.mjs,
// commands/daemon.mjs, commands/service.mjs, tui/slash_dashboard.mjs).
//
// Precedence, per surface: explicit --port flag > cfg.<surface>.port >
// DEFAULT_PORT. Surface-scoped config beats a shared default so a user can
// move ONE surface off a collision without touching the others. A PRESENT
// but invalid --port throws (InvalidPortError) rather than falling through —
// see resolvePort's own comment.
//
// Backward compatibility is load-bearing: an existing config.json with no
// port sections must resolve to DEFAULT_PORT for every surface, exactly as
// the hardcoded literals did.

export const DEFAULT_PORT = 19600;

// Thrown by resolvePort when an explicit --port flag is PRESENT but does not
// parse to a usable port. Before this resolver existed, a bad --port reached
// server.listen() and Node itself threw ERR_SOCKET_BAD_PORT — loud and
// immediate. A flag that is merely ABSENT still falls through to config, then
// DEFAULT_PORT (unchanged); only a present-but-invalid value throws. Do not
// "simplify" this into a silent fallthrough — that would trade the visible
// crash for "the port you asked for quietly didn't take effect", which is
// precisely the failure this module exists to eliminate (see ports-report.md,
// Fix round 1).
export class InvalidPortError extends RangeError {
  constructor(surface, value) {
    super(`${surface}: invalid --port "${value}" — must be an integer between 0 and 65535 (0 = pick any free port)`);
    this.name = 'InvalidPortError';
    this.surface = surface;
    this.value = value;
  }
}

const SURFACES = new Set(['gateway', 'dashboard', 'daemon']);

function _assertSurface(surface) {
  if (!SURFACES.has(surface)) {
    throw new Error(`ports: unknown surface "${surface}" (expected gateway|dashboard|daemon)`);
  }
}

// A persistable port: an integer in the non-privileged range. Applied to
// whatever config.json holds (configuredPort) and to `/gateway port <N>`'s
// own input validation, so a typo'd or out-of-range value never propagates as
// a real bind target or gets written to disk.
export function isValidPort(n) {
  return Number.isInteger(n) && n >= 1024 && n <= 65535;
}

// A raw TCP port number, the full 16-bit range. 0 is Node's own "let the OS
// pick an ephemeral port" sentinel — used by the gateway e2e test and by the
// EADDRINUSE random-port fallbacks — so an explicit --port flag accepts it
// too, unlike the narrower persisted-config range above. Anything else an
// operator explicitly passes (including a privileged port <1024) is honored
// as-is, matching the zero validation the five hardcoded call sites this
// module replaces used to apply to their own --port flag.
function _isPortNumber(n) {
  return Number.isInteger(n) && n >= 0 && n <= 65535;
}

// What cfg says for this surface's port, or null when unset/absent/invalid.
// Never throws on a malformed config — an out-of-range or non-numeric value
// is treated the same as "not configured".
export function configuredPort(surface, cfg) {
  _assertSurface(surface);
  const section = cfg && typeof cfg === 'object' ? cfg[surface] : null;
  if (!section || typeof section !== 'object') return null;
  const n = Number(section.port);
  return isValidPort(n) ? n : null;
}

// Precedence: explicit flag > surface-scoped config > DEFAULT_PORT.
//
// ABSENT (flags.port === undefined) falls through to config, then the
// default — unchanged. PRESENT-but-invalid (non-numeric, out of the 16-bit
// range) throws InvalidPortError rather than falling through: a typo'd
// --port must never be silently replaced by whatever config/default happens
// to say, because "the value quietly didn't take effect" is indistinguishable
// from success until something collides later. Callers that can only return
// a string (slash handlers) must catch this; callers that are already a CLI
// boot path should let it propagate to their existing fatal-config-error
// reporting (see commands/gateway.mjs, commands/daemon.mjs, commands/
// service.mjs for the house style each already uses).
export function resolvePort(surface, flags = {}, cfg = {}) {
  _assertSurface(surface);
  if (flags && flags.port !== undefined) {
    const n = parseInt(flags.port, 10);
    if (_isPortNumber(n)) return n;
    throw new InvalidPortError(surface, flags.port);
  }
  const fromCfg = configuredPort(surface, cfg);
  if (fromCfg != null) return fromCfg;
  return DEFAULT_PORT;
}
