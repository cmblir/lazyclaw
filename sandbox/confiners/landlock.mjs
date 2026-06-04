// sandbox/confiners/landlock.mjs — Linux Landlock helper.
//
// Landlock is enforced from *inside* the process via the
// landlock_create_ruleset() syscall. With no native bindings available
// in plain Node, we currently emit the argv unchanged and let
// downstream tooling (e.g. a future `lazyclaw-landlock-shim` binary)
// install the ruleset. Returns argv unchanged on non-Linux.

export function available() { return process.platform === 'linux'; }

export function buildArgv(argv, _opts = {}) {
  // Pass-through. Spec §0.1 C8 leaves room for a preloader binary.
  return [...argv];
}
