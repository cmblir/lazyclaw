// commands/login.mjs — `lazyclaw login [claude]`.
//
// lazyclaw is keyless: chatting via the claude-cli provider spawns the `claude`
// binary, which carries its own login. But the model-LISTING path makes a
// direct api.anthropic.com call that needs a bearer, and on macOS the `claude`
// login lives in the Keychain (no credential file), so listing failed with
// "set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN". This command resolves the
// credential across env / file / Keychain and, when none is present, mints a
// long-lived token via `claude setup-token`. The minted token is stored in
// <config>/.env (0600, gitignored) — the same env path model listing reads.

import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { _claudeCodeOAuthToken } from '../providers/model_catalogue.mjs';
import { readClaudeKeychainToken } from '../providers/claude_keychain.mjs';
import { writeDotenvMerge } from '../dotenv_min.mjs';
import { configPath } from '../lib/config.mjs';

// Where the claude-cli bearer comes from, in priority order. Pure + injectable.
export function resolveClaudeAuth({ env = process.env, home, readFileSync, keychainReader } = {}) {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { authenticated: true, source: 'env' };
  if (env.ANTHROPIC_API_KEY) return { authenticated: true, source: 'apiKey' };
  // Credential file (Linux / non-keychain) — keychain disabled here so we can
  // distinguish the two sources for the status message.
  const fileTok = _claudeCodeOAuthToken({ home, readFileSync, keychainReader: () => null });
  if (fileTok) return { authenticated: true, source: 'file' };
  const kcTok = (keychainReader || readClaudeKeychainToken)();
  if (kcTok) return { authenticated: true, source: 'keychain' };
  return { authenticated: false, source: 'none' };
}

function _hasClaudeBinary() {
  try { execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 4000 }); return true; }
  catch { return false; }
}

function _runSetupToken() {
  return new Promise((resolve) => {
    try {
      const p = spawn('claude', ['setup-token'], { stdio: 'inherit' });
      p.on('exit', (code) => resolve(code ?? 1));
      p.on('error', () => resolve(1));
    } catch { resolve(1); }
  });
}

const SOURCE_LABEL = {
  env: 'CLAUDE_CODE_OAUTH_TOKEN env var',
  apiKey: 'ANTHROPIC_API_KEY env var',
  file: 'claude credential file (~/.claude)',
  keychain: 'macOS Keychain (your `claude login`)',
};

export async function cmdLogin(positional = [], flags = {}, deps = {}) {
  const log = deps.log || ((s) => process.stdout.write(s + '\n'));
  const err = deps.err || ((s) => process.stderr.write(s + '\n'));
  const provider = String(positional[0] || 'claude').toLowerCase();
  if (provider !== 'claude' && provider !== 'claude-cli') {
    err(`login: only 'claude' is supported right now (got "${provider}"). Other providers use their own CLI login.`);
    return 2;
  }
  const cfgDir = deps.cfgDir || path.dirname(configPath());
  const resolve = deps.resolve || resolveClaudeAuth;
  const writeEnv = deps.writeEnv || ((vars) => writeDotenvMerge(cfgDir, vars));

  // Save a token the user already minted (e.g. via `claude setup-token`).
  if (flags.token) {
    const tok = String(flags.token).trim();
    if (!tok) { err('login: --token was empty'); return 2; }
    writeEnv({ CLAUDE_CODE_OAUTH_TOKEN: tok });
    log('✓ saved CLAUDE_CODE_OAUTH_TOKEN to <config>/.env (0600). claude-cli model listing + recall will use it.');
    return 0;
  }

  const status = resolve();
  if (status.authenticated) {
    log(`✓ claude-cli is already authenticated — via ${SOURCE_LABEL[status.source] || status.source}.`);
    log('  Model listing, recall, and the keyless trainer will work. Nothing to do.');
    return 0;
  }

  if (flags.check) {
    err('✗ no claude-cli credential found (no env token, ~/.claude credential file, or macOS Keychain login).');
    return 1;
  }

  const hasClaude = deps.hasClaudeBinary ? deps.hasClaudeBinary() : _hasClaudeBinary();
  if (!hasClaude) {
    err('No claude-cli credential found, and no `claude` binary on PATH.');
    log('Install the Claude CLI and log in:');
    log('  npm i -g @anthropic-ai/claude-code');
    log('  claude login');
    log('Then re-run `lazyclaw login`. (Headless/CI: set CLAUDE_CODE_OAUTH_TOKEN, or `lazyclaw login --token <token>`.)');
    return 1;
  }

  log('No usable credential found. Launching `claude setup-token` to mint a long-lived token…');
  log('(A browser opens for OAuth; the token is printed when it finishes.)\n');
  const code = deps.runSetupToken ? await deps.runSetupToken() : await _runSetupToken();
  if (code !== 0) {
    err('\n`claude setup-token` did not complete. Alternatively run `claude login`, then re-run `lazyclaw login`.');
    return 1;
  }
  log('\nDone. Copy the token printed above, then save it with EITHER:');
  log('  lazyclaw login --token <paste-token>      # writes <config>/.env (recommended)');
  log('  export CLAUDE_CODE_OAUTH_TOKEN=<paste-token>');
  return 0;
}
