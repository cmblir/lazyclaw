// lib/config_dir.mjs — single source of truth for the lazyclaw config
// directory. Previously copy-pasted byte-for-byte across goals/loops/memory/
// agents/skills/tasks/teams, which was a divergence hazard: a change to the
// env-var name or fallback in one copy would silently disagree with the rest.
//
// Resolution order, and why it is not a plain rename: the project shipped as
// `lazyclaw` through 6.10.0, so an existing install has real state — agents,
// teams, tasks, the search index — sitting in ~/.lazyclaw. Pointing the new name
// at an empty ~/.pompos would look to that operator like their work vanished.
//
//   1. POMPOS_CONFIG_DIR, then LAZYCLAW_CONFIG_DIR  (explicit always wins)
//   2. ~/.pompos      if it exists                  (already migrated)
//   3. ~/.lazyclaw    if it exists                  (pre-rename install)
//   4. ~/.pompos                                    (fresh install)
//
// Nothing is moved or copied. Adopting an old directory in place is reversible and
// costs nothing; migrating it silently is neither, and destroying or duplicating a
// user's state is not a decision this function gets to make. An operator who wants
// the new path can `mv ~/.lazyclaw ~/.pompos` and rule 2 takes over.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LEGACY_DIRNAME = '.lazyclaw';
const DIRNAME = '.pompos';

export function defaultConfigDir() {
  const explicit = process.env.POMPOS_CONFIG_DIR || process.env.LAZYCLAW_CONFIG_DIR;
  if (explicit) return explicit;
  const home = os.homedir();
  const current = path.join(home, DIRNAME);
  if (dirExists(current)) return current;
  const legacy = path.join(home, LEGACY_DIRNAME);
  if (dirExists(legacy)) return legacy;
  return current;
}

// A path that exists but is a file, or that we cannot stat, must not count as the
// config directory — treating it as one would make every later read fail with a
// confusing ENOTDIR far from here.
function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// Lightweight per-key in-process async mutex — a promise chain keyed by an
// arbitrary string (a task/goal id or a file path). Callers serialize a
// read-modify-write sequence with:
//
//   const result = await withKeyedLock(key, async () => { ... });
//
// Each key gets its own tail promise; a new critical section waits on the
// previous one for the SAME key and runs concurrently for different keys.
// The tail is pruned once it is the last waiter so the map does not grow
// without bound.
//
// SCOPE: this only serializes writers inside a SINGLE process (e.g. one
// daemon). It does NOT provide cross-process locking — two separate processes
// (daemon + CLI) can still lost-update. A cross-process file lock is a later
// phase; this fixes the common same-process race.
const _locks = new Map();

export function withKeyedLock(key, fn) {
  const prev = _locks.get(key) || Promise.resolve();
  // Chain onto the previous holder, swallowing its rejection so one failed
  // critical section does not poison the queue for the next caller.
  const run = prev.then(() => fn(), () => fn());
  // The tail resolves after `run` settles, regardless of outcome.
  const tail = run.then(() => {}, () => {});
  _locks.set(key, tail);
  // Prune the entry once we are the last waiter, so the map does not leak.
  tail.then(() => {
    if (_locks.get(key) === tail) _locks.delete(key);
  });
  return run;
}

// Synchronous keyed critical section. The RMW helpers here (patchTask,
// appendTurn, patchGoal, appendCheckIn, thread upsert, PairingStore approve)
// are synchronous — read+modify+write happen with no `await` between them, so
// under Node's single-threaded model they already run indivisibly and cannot
// interleave with another same-process caller. This wrapper makes that
// invariant explicit and enforced: it throws on reentrancy for the same key,
// which can only happen if a future edit splits the RMW across an await (the
// exact shape that would reintroduce the lost-update race). At that point the
// bug is loud instead of silent, and the fix is to migrate that call site to
// the async `withKeyedLock` above.
const _syncHeld = new Set();

export function withKeyedLockSync(key, fn) {
  if (_syncHeld.has(key)) {
    throw new Error(`withKeyedLockSync: reentrant/overlapping critical section for key "${key}" — the read-modify-write must run synchronously; migrate this call site to the async withKeyedLock`);
  }
  _syncHeld.add(key);
  try {
    return fn();
  } finally {
    _syncHeld.delete(key);
  }
}
