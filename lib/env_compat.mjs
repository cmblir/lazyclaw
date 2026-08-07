// lib/env_compat.mjs — keep the pre-rename environment working.
//
// The project was `lazyclaw` through 6.10.0 and reads 42 distinct `LAZYCLAW_*`
// variables from `process.env` directly, at call sites spread across the codebase
// with no central accessor. Renaming each read would touch dozens of files and
// still break every operator's existing shell profile, CI secret, systemd unit and
// launchd plist.
//
// So instead of teaching every call site two names, the two namespaces are
// mirrored once at process start. After this runs, a variable set under either
// prefix is readable under both, and no call site needs to know the rename
// happened.
//
// Mirroring is one-way per variable and never overwrites: whichever name the
// operator actually set wins, and the other is filled in from it. Setting both to
// different values is the operator's own contradiction, so the explicit new-prefix
// value is left alone rather than silently replaced.

const OLD = 'LAZYCLAW_';
const NEW = 'POMPOS_';

/**
 * Mirror every `LAZYCLAW_*` / `POMPOS_*` variable across both prefixes.
 *
 * @param {Record<string, string | undefined>} [env] defaults to process.env
 * @returns {{ filled: string[] }} the names this call created, for tests and --debug
 */
export function applyEnvCompat(env = process.env) {
  const filled = [];
  // Snapshot the keys first: assigning into `env` during iteration would otherwise
  // let a just-created name be re-read as a source in the same pass.
  for (const key of Object.keys(env)) {
    let from, to;
    if (key.startsWith(OLD)) { from = key; to = NEW + key.slice(OLD.length); }
    else if (key.startsWith(NEW)) { from = key; to = OLD + key.slice(NEW.length); }
    else continue;
    // Empty counts as unset, in both directions. `env: { ...process.env, FOO: '' }`
    // is the ordinary way to clear a variable for a child process, and a shell can
    // export an empty one too — so an empty LAZYCLAW_ name must not block its
    // POMPOS_ mirror, and an empty value must not be propagated as if it were a
    // real one. Treating '' as set is exactly the bug the ordering test caught:
    // Number('') || 20 quietly returns the default instead of the configured value.
    if (!env[to] && env[from]) {
      env[to] = env[from];
      filled.push(to);
    }
  }
  return { filled };
}
