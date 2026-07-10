// mas/index_failures.mjs — index write-failure logging + native ABI hinting.
//
// Extracted verbatim from index_db.mjs (behavior-preserving split) to keep
// that file under the size gate. index_db re-exports the test-seam helpers
// (_resetNativeHint / _isNativeAbiError / _warnIndexFailure) so their import
// path stays '../mas/index_db.mjs'. Console strings keep the [index_db]
// prefix intentionally — the user-facing hint must not change.

import fs from 'node:fs';
import path from 'node:path';

// m11 — when a write-through hook fails, append a structured entry to
// <configDir>/index-failures.jsonl so `lazyclaw doctor` can surface
// recent failures (last 24h) and the operator can rebuild before the
// silent stale-index problem compounds. Best-effort: any error during
// the append itself is swallowed (we don't want to spam stderr from a
// background hook).
export function _logIndexFailure(configDir, scope, err) {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    const file = path.join(configDir, 'index-failures.jsonl');
    const entry = {
      ts: new Date().toISOString(),
      event: 'index.write.failed',
      scope,
      error: String(err?.message || err || 'unknown'),
    };
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch { /* swallow — surface only via console.warn below */ }
}

// The native better-sqlite3 addon fails to load when node_modules was built
// against a different Node.js ABI than the one running lazyclaw (a Node switch
// via nvm/brew, or copied node_modules). Every index op then throws the same
// thing — so instead of dumping the raw stack on each write, recognise it and
// print ONE actionable hint, then stay quiet. Chat is unaffected; only recall /
// skill search degrade until the addon is rebuilt.
let _nativeHintShown = false;
export function _resetNativeHint() { _nativeHintShown = false; } // test seam
export function _isNativeAbiError(e) {
  return /NODE_MODULE_VERSION|was compiled against a different Node|better_sqlite3\.node|invalid ELF header|dlopen\(/i
    .test(String(e?.message || e || ''));
}
export function _warnIndexFailure(label, e) {
  // Index internals stay off the user's screen: recorded in index-failures.jsonl
  // (+ surfaced by `lazyclaw doctor`); echoed to the console only when an
  // operator sets LAZYCLAW_DEBUG. End users never see DB error codes.
  if (!process.env.LAZYCLAW_DEBUG) return;
  if (_isNativeAbiError(e)) {
    if (_nativeHintShown) return;
    _nativeHintShown = true;
    // eslint-disable-next-line no-console
    console.warn('[index_db] recall index disabled — better-sqlite3 ABI mismatch; run `npm rebuild better-sqlite3`.');
    return;
  }
  // eslint-disable-next-line no-console
  console.warn(`[index_db] ${label}:`, e.message);
}
