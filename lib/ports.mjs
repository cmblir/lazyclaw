// lib/ports.mjs — single resolver for the HTTP port each long-running surface
// (gateway / dashboard / the daemon-as-a-service) binds to. Replaces five
// independent `19600` literals that used to make dashboard / gateway / the
// installed daemon service collide by construction (commands/gateway.mjs,
// commands/daemon.mjs, commands/service.mjs, tui/slash_dashboard.mjs).
//
// Precedence, per surface: explicit --port flag > cfg.<surface>.port >
// DEFAULT_PORT. Surface-scoped config beats a shared default so a user can
// move ONE surface off a collision without touching the others.
//
// Backward compatibility is load-bearing: an existing config.json with no
// port sections must resolve to DEFAULT_PORT for every surface, exactly as
// the hardcoded literals did.

export const DEFAULT_PORT = 19600;

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

// Precedence: explicit flag > surface-scoped config > DEFAULT_PORT. An
// invalid explicit flag (non-numeric, out of the 16-bit port range) is
// treated as absent rather than propagated — it falls through to config,
// then the default, instead of handing a NaN or nonsense port number to
// whatever binds it.
export function resolvePort(surface, flags = {}, cfg = {}) {
  _assertSurface(surface);
  if (flags && flags.port !== undefined) {
    const n = parseInt(flags.port, 10);
    if (_isPortNumber(n)) return n;
  }
  const fromCfg = configuredPort(surface, cfg);
  if (fromCfg != null) return fromCfg;
  return DEFAULT_PORT;
}
