// sandbox/confiners/landlock.mjs — Linux Landlock helper.
//
// Landlock is enforced from *inside* the process via the
// landlock_create_ruleset() syscall, which needs a native binding / preloader
// shim that pompos does not ship yet. The previous implementation returned
// the argv UNCHANGED, so selecting `confiner: landlock` ran the command with
// ZERO confinement while reporting itself available — a false security
// guarantee that is worse than `none`. Until a real enforcer ships we report
// unavailable and refuse to build an argv, so the request fails closed instead
// of silently running unconfined.

export function available() { return false; }

export function buildArgv() {
  throw new Error(
    'landlock confiner is not implemented (no enforcement shim is shipped) — ' +
    'it would run the command unconfined. Use confiner bubblewrap or firejail ' +
    'on Linux, or set confiner:none deliberately.',
  );
}
