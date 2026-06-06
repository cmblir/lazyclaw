// secure_write.mjs — atomic file writes with owner-only (0600/0700) perms,
// for files that hold secrets: config.json (plaintext API keys / auth
// profiles), workflow state (transcript content), any .env the tool writes.
//
// Lifted from gateway/device_auth.mjs::writeAtomic: set restrictive modes on
// create AND re-assert with chmod after rename, because the active umask can
// clear bits at mkdir/open time and a pre-existing file keeps its old (looser)
// mode otherwise. chmod is best-effort (a no-op / unsupported on some
// filesystems and on Windows); the {mode} on write is the primary guard.

import fs from 'node:fs';
import path from 'node:path';

export const SECURE_DIR_MODE = 0o700;
export const SECURE_FILE_MODE = 0o600;

function chmodQuiet(p, mode) {
  try { fs.chmodSync(p, mode); } catch { /* unsupported FS / platform — mode on write stands */ }
}

export function writeTextSecure(filePath, text) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: SECURE_DIR_MODE });
  chmodQuiet(dir, SECURE_DIR_MODE);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, text, { mode: SECURE_FILE_MODE });
  chmodQuiet(tmp, SECURE_FILE_MODE);
  fs.renameSync(tmp, filePath);
  chmodQuiet(filePath, SECURE_FILE_MODE);
}

export function writeJsonSecure(filePath, obj) {
  writeTextSecure(filePath, JSON.stringify(obj, null, 2));
}

// Tighten an existing secrets file to 0600 if it is currently group/other
// accessible. Best-effort + idempotent — used to migrate already-deployed
// world-readable config.json the first time it is read. Returns true if it
// changed the mode.
export function tightenIfLoose(filePath) {
  try {
    const st = fs.statSync(filePath);
    if ((st.mode & 0o077) !== 0) { fs.chmodSync(filePath, SECURE_FILE_MODE); return true; }
  } catch { /* missing / unreadable → nothing to tighten */ }
  return false;
}
