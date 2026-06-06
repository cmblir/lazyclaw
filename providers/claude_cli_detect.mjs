// claude_cli_detect.mjs — detect a usable claude-cli subscription session.
//
// resolveTrainer's `auto` branch routes the $0 learning loop to claude-cli
// only when a Pro/Max session is detected. The original detector keyed solely
// on an exported CLAUDE_CODE_OAUTH_TOKEN env var — which a normal `claude
// login` never sets (it writes the OS keychain / ~/.claude) — so `auto`
// silently fell back to the paid chat provider for real subscribers. This
// detector also accepts the credential store and the `claude` binary on PATH.
// Pure + offline (no network); the binary probe is the only subprocess and is
// bounded by a short timeout.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export function detectClaudeCliSession({ env = process.env, home = os.homedir() } = {}) {
  // 1. Explicit token (CI / headless) — definitive.
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { available: true, source: 'env', reason: 'CLAUDE_CODE_OAUTH_TOKEN set' };
  }
  // 2. Credential store written by `claude login` (Linux / non-keychain).
  for (const rel of ['.claude/.credentials.json', '.claude.json', '.config/claude/.credentials.json']) {
    try { if (fs.existsSync(path.join(home, rel))) return { available: true, source: 'credentials', reason: rel }; }
    catch { /* ignore unreadable */ }
  }
  // 3. `claude` on PATH. On macOS the login lives in the Keychain with no
  //    credential file, so binary presence is the best offline signal we have.
  //    If it turns out not to be logged in, the trainer call fails (best-effort,
  //    swallowed) — no billing — rather than silently charging the paid path.
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 4000 });
    return { available: true, source: 'binary', reason: 'claude on PATH' };
  } catch { /* ENOENT / nonzero / timeout */ }
  return { available: false, source: 'none', reason: 'no env token, credential store, or claude binary' };
}

let _cache = null; // memoize per-process — detection does not change mid-run

// Boolean for the hot resolveTrainer path. Explicit opts bypass the cache
// (tests inject env/home); the no-arg call memoizes.
export function hasClaudeCliSession(opts) {
  if (opts) return detectClaudeCliSession(opts).available;
  if (_cache === null) _cache = detectClaudeCliSession().available;
  return _cache;
}
