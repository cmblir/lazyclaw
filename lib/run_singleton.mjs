// lib/run_singleton.mjs — cross-process per-name singleton lock for
// unattended automation (loop / goal ticks).
//
// WHY a NEW lock on top of lib/config_dir.mjs withKeyedLock:
//   withKeyedLock / withKeyedLockSync only serialize writers inside ONE
//   process. But a slow scheduled `goal tick` still running when the next
//   cron fire arrives is a SEPARATE process, as is a manual `goal tick`
//   racing the scheduled one. Two processes both open the same goal:<name>
//   session and concurrently appendCheckIn — an in-process mutex cannot see
//   the other process. This provides the cross-process guard.
//
// Mechanism: an O_EXCL lockfile ({ pid, startedAt, ttlMs }) written
// atomically under <dir>/<name>.lock. O_EXCL is the POSIX atomic
// "create-if-absent" primitive — exactly one writer wins the race even
// across processes. A stale lock (dead pid, or age > ttlMs) is reclaimed.
//
// Overlap policy (default SKIP): when the lock is already held by a live
// holder, acquire() returns { acquired:false, holder } instead of blocking.
// The caller logs and skips the fire. This is additive + opt-in: nothing
// calls it unless a call site chooses to.

import fs from 'node:fs';
import path from 'node:path';

// Default TTL: a lock older than this is presumed stale even if the pid
// still resolves (e.g. pid reuse). Generous so a legitimately slow tick is
// not stolen mid-run.
export const DEFAULT_LOCK_TTL_MS = 60 * 60 * 1000; // 1h

function lockPath(dir, name) {
  if (!name || /[/\\]/.test(name) || name === '.' || name === '..') {
    throw new Error(`invalid singleton lock name: ${name}`);
  }
  return path.join(dir, `${name}.lock`);
}

function isPidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e?.code === 'EPERM'; } // EPERM = alive but not ours
}

function readLock(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

// A held lock is STALE (reclaimable) when its owner pid is dead OR the lock
// is older than its ttl. Own-process re-entry is NOT stale (see acquire).
function isStale(rec, now) {
  if (!rec || typeof rec !== 'object') return true; // garbage → reclaim
  const ttl = Number.isFinite(rec.ttlMs) ? rec.ttlMs : DEFAULT_LOCK_TTL_MS;
  const startedAt = Number(rec.startedAt) || 0;
  if (now - startedAt > ttl) return true;
  return !isPidAlive(rec.pid);
}

/**
 * Try to acquire the per-name singleton lock. Non-blocking (SKIP policy).
 *
 * @param {string} name              per-schedule name (loop id or goal name)
 * @param {object} [opts]
 * @param {string} opts.dir          directory to hold the lockfile (required)
 * @param {number} [opts.ttlMs]      staleness TTL (default 1h)
 * @param {number} [opts.pid]        owner pid (default process.pid) — for tests
 * @param {() => number} [opts.now]  clock injection (default Date.now)
 * @returns {{ acquired:boolean, release:()=>void, holder?:object, stolen?:boolean }}
 */
export function acquire(name, { dir, ttlMs = DEFAULT_LOCK_TTL_MS, pid = process.pid, now = Date.now } = {}) {
  if (!dir) throw new Error('run_singleton.acquire requires opts.dir');
  fs.mkdirSync(dir, { recursive: true });
  const file = lockPath(dir, name);
  const rec = { pid, startedAt: now(), ttlMs };
  const payload = JSON.stringify(rec);

  let stolen = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // O_EXCL: atomic create-if-absent. Wins the cross-process race.
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, payload); } finally { fs.closeSync(fd); }
      return { acquired: true, release: () => release(file, pid), stolen };
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      // Lock exists. Reclaim it if the holder is dead / expired, else SKIP.
      const held = readLock(file);
      if (isStale(held, now())) {
        try { fs.unlinkSync(file); stolen = true; continue; } // retry create
        catch { /* someone else reclaimed first — fall through to skip */ }
      }
      return { acquired: false, release: () => {}, holder: held || null };
    }
  }
  // Lost the reclaim race on both attempts — treat as held by the winner.
  return { acquired: false, release: () => {}, holder: readLock(file) };
}

// Release only if WE still own it — never delete a lock a later holder
// reclaimed from us (defends the stale-reclaim path from a double free).
function release(file, pid) {
  const held = readLock(file);
  if (held && held.pid !== pid) return; // not ours anymore; leave it
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

/**
 * Run `fn` under the singleton lock. If the lock is held by a live holder,
 * SKIP (do not run fn) and return { skipped:true, holder }. Releases in
 * finally on all paths (success, throw, async rejection).
 *
 * @param {string} name
 * @param {object} opts   see acquire()
 * @param {() => any} fn  work to run while holding the lock
 * @returns {Promise<{ skipped:boolean, holder?:object, result?:any, stolen?:boolean }>}
 */
export async function withSingleton(name, opts, fn) {
  const lk = acquire(name, opts);
  if (!lk.acquired) return { skipped: true, holder: lk.holder || null };
  try {
    const result = await fn();
    return { skipped: false, result, stolen: lk.stolen };
  } finally {
    lk.release();
  }
}
