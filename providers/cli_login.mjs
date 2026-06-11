// providers/cli_login.mjs — connect/login helpers for the keyless CLI
// providers (codex-cli / gemini-cli) so the picker can offer an inline
// "log in / connect" action instead of dead-ending on the CLI's own
// "please log in" message.
//
// Two halves:
//   - cliLoginStatus(): pure, dependency-injectable detection of whether a
//     provider's CLI is installed and signed in (unit-tested).
//   - runCliLoginInteractive(): spawns the real login / install subprocess
//     with the terminal inherited. Driven from the chat post-loop guard
//     after the Ink UI releases stdin (same mechanism /setup uses), so the
//     browser-OAuth flow gets a real TTY.
//
// codex has a headless login (`codex login`, `codex login status`); gemini
// does NOT — its Google sign-in only happens by launching `gemini`
// interactively, or by supplying GEMINI_API_KEY. We model both.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync as _existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CLI_LOGIN_PROVIDERS = {
  'codex-cli': {
    bin: 'codex',
    pkg: '@openai/codex',
    // `codex login` opens a browser for ChatGPT OAuth; `codex login status`
    // exits 0 when signed in. `codex login --with-api-key` reads a key on stdin.
    loginArgs: ['login'],
    statusArgs: ['login', 'status'],
    apiKeyStdinArgs: ['login', '--with-api-key'],
    browserHint: 'codex login',
    apiKeyHint: 'OpenAI key (sk-…) — stored by codex via `codex login --with-api-key`',
  },
  'gemini-cli': {
    bin: 'gemini',
    pkg: '@google/gemini-cli',
    // No headless login: Google OAuth only runs when `gemini` is launched
    // interactively. We detect sign-in by the presence of the OAuth creds
    // file (or a GEMINI_API_KEY in the environment).
    loginArgs: [],
    credPath: join(homedir(), '.gemini', 'oauth_creds.json'),
    apiKeyEnv: 'GEMINI_API_KEY',
    browserHint: 'gemini (Google sign-in)',
    apiKeyHint: 'Google AI Studio key — saved in lazyclaw and passed as GEMINI_API_KEY',
  },
};

// Locate a binary on PATH without throwing. Returns the path or ''.
function _whichSync(bin) {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
    if (r.status === 0) return String(r.stdout || '').split('\n')[0].trim();
  } catch (_) { /* ignore */ }
  return '';
}

// Run `<bin> <args>` just for its exit code (codex login status). Resolves the
// numeric code (or 1 on spawn error) — never rejects.
function _runForCode(bin, args) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch (_) { resolve(1); return; }
    proc.once('error', () => resolve(1));
    proc.once('close', (code) => resolve(typeof code === 'number' ? code : 1));
  });
}

/**
 * Detect whether a keyless CLI provider is installed and signed in.
 * All side-effecting lookups are injectable so this is unit-testable.
 *
 * @param {string} provName  'codex-cli' | 'gemini-cli'
 * @param {{
 *   which?: (bin:string)=>string,
 *   runStatus?: (bin:string, args:string[])=>Promise<number>,
 *   existsSync?: (p:string)=>boolean,
 *   env?: Record<string,string|undefined>,
 *   hasStoredKey?: boolean,   // a key already saved in lazyclaw for this provider
 * }} [deps]
 * @returns {Promise<{supported:boolean, binMissing?:boolean, loggedIn?:boolean, via?:string, pkg?:string}>}
 */
export async function cliLoginStatus(provName, deps = {}) {
  const spec = CLI_LOGIN_PROVIDERS[provName];
  if (!spec) return { supported: false };
  const which = deps.which || _whichSync;
  if (!which(spec.bin)) {
    return { supported: true, binMissing: true, loggedIn: false, pkg: spec.pkg };
  }
  // An explicit lazyclaw-stored key means we can authenticate regardless of
  // the CLI's own login state (codex via env, gemini via GEMINI_API_KEY).
  if (deps.hasStoredKey) return { supported: true, binMissing: false, loggedIn: true, via: 'api-key' };
  if (spec.statusArgs) {
    const code = await (deps.runStatus || _runForCode)(spec.bin, spec.statusArgs);
    return { supported: true, binMissing: false, loggedIn: code === 0, via: `${spec.bin} ${spec.statusArgs.join(' ')}` };
  }
  // gemini: no status command — infer from creds file / env key.
  const existsSync = deps.existsSync || _existsSync;
  const env = deps.env || process.env;
  const ok = (!!spec.credPath && existsSync(spec.credPath)) || (!!spec.apiKeyEnv && !!env[spec.apiKeyEnv]);
  return { supported: true, binMissing: false, loggedIn: ok, via: 'creds/env' };
}

// Spawn a command with the terminal inherited; resolve on close (never reject).
function _spawnInherit(bin, args, opts = {}) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(bin, args, { stdio: 'inherit', ...opts });
    } catch (e) {
      process.stderr.write(`\n  failed to launch ${bin}: ${e?.message || e}\n`);
      resolve(1);
      return;
    }
    proc.once('error', (e) => { process.stderr.write(`\n  ${bin} error: ${e?.message || e}\n`); resolve(1); });
    proc.once('close', (code) => resolve(typeof code === 'number' ? code : 0));
  });
}

// Pipe a secret to a command's stdin (codex login --with-api-key), inheriting
// stdout/stderr so the user sees the result. Resolves the exit code.
function _spawnKeyStdin(bin, args, key) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(bin, args, { stdio: ['pipe', 'inherit', 'inherit'] });
    } catch (e) { process.stderr.write(`\n  failed to launch ${bin}: ${e?.message || e}\n`); resolve(1); return; }
    proc.once('error', (e) => { process.stderr.write(`\n  ${bin} error: ${e?.message || e}\n`); resolve(1); });
    proc.once('close', (code) => resolve(typeof code === 'number' ? code : 0));
    try { proc.stdin.write(String(key || '')); proc.stdin.end(); } catch (_) { /* closed already */ }
  });
}

/**
 * Run the chosen connect action in the foreground (terminal inherited). Called
 * from the chat post-loop guard once Ink has released stdin.
 *
 * @param {{ provider:string, mode:'browser'|'install'|'apikey', apiKey?:string }} req
 */
export async function runCliLoginInteractive(req = {}) {
  const { provider, mode, apiKey } = req;
  const spec = CLI_LOGIN_PROVIDERS[provider];
  if (!spec) { process.stderr.write(`\n  unknown login provider: ${provider}\n`); return; }
  const dim = (s) => `\x1b[2m${s}\x1b[0m`;
  const ok = (s) => `\x1b[32m${s}\x1b[0m`;

  if (mode === 'install') {
    process.stdout.write(`\n  Installing ${spec.pkg} …  ${dim(`npm i -g ${spec.pkg}`)}\n\n`);
    const code = await _spawnInherit('npm', ['i', '-g', spec.pkg]);
    process.stdout.write(code === 0
      ? `\n  ${ok('✓ installed')} ${spec.pkg}. Re-open ${dim(`/provider ${provider}`)} to sign in.\n\n`
      : `\n  install exited ${code}. You can run ${dim(`npm i -g ${spec.pkg}`)} yourself.\n\n`);
    return;
  }

  if (mode === 'apikey') {
    if (provider === 'codex-cli') {
      process.stdout.write(`\n  Storing your OpenAI key via ${dim('codex login --with-api-key')} …\n\n`);
      const code = await _spawnKeyStdin(spec.bin, spec.apiKeyStdinArgs, apiKey);
      process.stdout.write(code === 0 ? `\n  ${ok('✓ codex signed in with an API key.')}\n\n` : `\n  codex login exited ${code}.\n\n`);
    }
    // gemini's key is persisted in lazyclaw config by the caller and injected
    // as GEMINI_API_KEY at spawn time — nothing to run here.
    return;
  }

  // Browser OAuth.
  if (provider === 'codex-cli') {
    process.stdout.write(`\n  Opening ${dim('codex login')} — a sign-in URL will appear. Complete it in your browser, then return here.\n\n`);
    const code = await _spawnInherit(spec.bin, spec.loginArgs);
    process.stdout.write(code === 0 ? `\n  ${ok('✓ codex signed in.')}\n\n` : `\n  codex login exited ${code}.\n\n`);
  } else if (provider === 'gemini-cli') {
    process.stdout.write(`\n  Launching ${dim('gemini')} for Google sign-in. Authenticate in the browser, then ${dim('/quit')} (or Ctrl-C) inside gemini to return.\n\n`);
    await _spawnInherit(spec.bin, spec.loginArgs);
    process.stdout.write(`\n  Back in lazyclaw.\n\n`);
  }
}
