// workflow/session_lock.mjs — advisory per-sessionId run lock.
//
// A workflow session's state file (<dir>/<sessionId>.json) is mutated in place
// by runPersistent / runPersistentDag. Two runs on the SAME sessionId (a
// concurrent daemon POST, cron overlapping a manual resume) would race that
// file and double-execute side-effecting nodes. This module provides an
// advisory lock keyed by sessionId so the second concurrent run REFUSES with a
// clear, coded error instead of racing.
//
// Mechanism: an O_EXCL lockfile (<dir>/<sessionId>.lock) created with flag 'wx'
// — the OS guarantees only one creator wins. The file carries { pid, startedAt,
// hostname } so a STALE lock (crashed holder) can be detected + reclaimed: the
// holder pid is dead (process.kill(pid, 0) throws ESRCH) OR the lock age passed
// the TTL. Reclaim is best-effort and re-attempts the exclusive create once.
//
// Failure isolation: acquire never throws for a stale/own lock — only for a
// genuinely-held LIVE lock, surfaced as Error{code:'SESSION_LOCKED'}. Release
// is idempotent and swallows a missing/foreign file so a finally-path caller
// never sees a secondary throw masking the real result.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SECURE_DIR_MODE, SECURE_FILE_MODE } from '../secure_write.mjs';

// A lock older than this (with no liveness signal) is treated as abandoned by a
// crashed holder. Deliberately generous: a real long-running workflow refreshes
// nothing, so the TTL is the ONLY age-based reclaim path — set it well past any
// plausible single node's wall time. Callers can override per-acquire.
export const DEFAULT_LOCK_TTL_MS = 6 * 60 * 60 * 1000; // 6h

export function lockPath(sessionId, dir) {
  return path.join(dir, `${sessionId}.lock`);
}

// Default liveness probe: signal 0 checks existence/permission without
// delivering a signal. ESRCH → dead. EPERM → alive (owned by another user).
function defaultPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM'; // exists but not ours → still alive
  }
}

function readLock(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    // Unreadable/corrupt lock (truncated mid-write, hand-edited) → treat as
    // reclaimable rather than wedging the session forever.
    return null;
  }
}

function isStale(info, { now, ttlMs, pidAlive }) {
  if (!info || typeof info !== 'object') return true;
  if (Number.isFinite(info.startedAt) && now - info.startedAt > ttlMs) return true;
  if (!pidAlive(info.pid)) return true;
  return false;
}

/**
 * Acquire the advisory lock for a sessionId. Returns a handle with an
 * idempotent release(). Throws Error{code:'SESSION_LOCKED'} if a LIVE run
 * already holds it.
 *
 * @param {string} sessionId
 * @param {string} dir
 * @param {{
 *   now?: number,
 *   ttlMs?: number,
 *   pidAlive?: (pid: number) => boolean,
 * }} [opts]
 * @returns {{ path: string, release: () => void, reclaimed: boolean }}
 */
export function acquireSessionLock(sessionId, dir, opts = {}) {
  const now = opts.now ?? Date.now();
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_LOCK_TTL_MS;
  const pidAlive = opts.pidAlive || defaultPidAlive;
  const p = lockPath(sessionId, dir);
  fs.mkdirSync(dir, { recursive: true, mode: SECURE_DIR_MODE });

  const payload = JSON.stringify({ pid: process.pid, startedAt: now, hostname: os.hostname() });
  let reclaimed = false;

  // Try the exclusive create; on collision decide stale-vs-live, reclaim once.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(p, payload, { flag: 'wx', mode: SECURE_FILE_MODE });
      return {
        path: p,
        reclaimed,
        release() { releaseSessionLock(p, now); },
      };
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        const info = readLock(p);
        if (isStale(info, { now, ttlMs, pidAlive })) {
          // Reclaim: remove the abandoned lock and retry the exclusive create.
          // A concurrent reclaimer might win the unlink→create race; the second
          // wx create then throws EEXIST again and we fall through to LOCKED.
          try { fs.unlinkSync(p); } catch { /* another reclaimer removed it */ }
          reclaimed = true;
          continue;
        }
        const err = new Error(
          `workflow session "${sessionId}" is already running (pid ${info?.pid ?? '?'} since ${info?.startedAt ? new Date(info.startedAt).toISOString() : '?'}); refuse to run concurrently`,
        );
        err.code = 'SESSION_LOCKED';
        err.holder = info || undefined;
        throw err;
      }
      throw e; // an unexpected fs error (permissions, ENOSPC) — surface it
    }
  }
  // Both attempts lost the reclaim race to another process — treat as LOCKED.
  const err = new Error(`workflow session "${sessionId}" lock contended; another run won the reclaim`);
  err.code = 'SESSION_LOCKED';
  throw err;
}

// Release is best-effort + idempotent: only unlink a lock we still own (its
// startedAt matches the value we wrote), so we never delete a lock a newer run
// legitimately reclaimed after WE went stale. A missing/foreign file is a no-op.
export function releaseSessionLock(p, startedAt) {
  try {
    const info = readLock(p);
    if (info && Number.isFinite(startedAt) && info.startedAt !== startedAt) return; // not ours anymore
    fs.unlinkSync(p);
  } catch { /* already gone / unreadable — nothing to release */ }
}
