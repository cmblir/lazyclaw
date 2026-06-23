// claude_keychain.mjs — read the Claude Code OAuth token from the macOS login
// Keychain.
//
// `claude login` on macOS stores its credential in the OS Keychain (there is no
// ~/.claude/.credentials.json file like on Linux), so lazyclaw's keyless paths
// (model listing, trainer detection) couldn't see an existing, working login
// and fell back to an "authenticate first" error. This reads that Keychain item
// — the same JSON blob the Linux file holds — and returns its accessToken.
//
// Read-only and macOS-only. The token is only ever sent to api.anthropic.com,
// never logged. The first read may surface a one-time Keychain access prompt;
// granting it ("Always Allow") makes subsequent reads silent.

import { execFileSync } from 'node:child_process';

// macOS stores the Claude Code credential under this generic-password service.
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

// Pull the accessToken out of the credential blob (same shape as the Linux
// ~/.claude/.credentials.json file). Returns a non-empty string or null.
export function _extractAccessToken(raw) {
  if (!raw || !String(raw).trim()) return null;
  let j;
  try { j = JSON.parse(raw); } catch { return null; }
  const o = (j && j.claudeAiOauth) || j || {};
  const tok = o.accessToken || o.access_token || (j && j.accessToken);
  return (typeof tok === 'string' && tok) ? tok : null;
}

// Read the Claude Code OAuth access token from the macOS Keychain. Returns the
// token string, or null on non-macOS, a missing item, denied access, or an
// unparseable blob. `exec`/`platform` are injectable for tests.
export function readClaudeKeychainToken({ platform = process.platform, exec } = {}) {
  if (platform !== 'darwin') return null;
  const run = exec || ((args) => execFileSync('security', args, { encoding: 'utf8', timeout: 8000 }));
  let raw;
  try { raw = run(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w']); }
  catch { return null; }
  return _extractAccessToken(raw);
}
