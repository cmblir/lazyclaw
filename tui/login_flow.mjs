// tui/login_flow.mjs — interactive "connect / log in" flow for the keyless
// CLI providers, factored out of slash_dispatcher.mjs so the dispatcher stays
// small. Drives the inline menu (browser OAuth / paste API key / install) that
// /provider and /login surface when codex-cli or gemini-cli is picked but not
// signed in. The actual subprocess (codex login, gemini, npm i -g) runs from
// the chat post-loop guard via providers/cli_login.mjs once Ink releases stdin;
// here we only decide what to queue and persist the chosen provider.

import { CLI_LOGIN_PROVIDERS, cliLoginStatus } from '../providers/cli_login.mjs';
import { setAuthKey } from '../providers/auth_store.mjs';

// Persist the chosen provider so the chat re-entered after a foreground login
// comes back on it. Best-effort; the in-memory switch already happened.
function _persistProvider(ctx, provName) {
  try {
    if (typeof ctx.readConfig === 'function' && typeof ctx.writeConfig === 'function') {
      const c = ctx.readConfig();
      c.provider = provName;
      ctx.writeConfig(c);
      if (ctx.cfg) ctx.cfg.provider = provName;
    }
  } catch (_) { /* best-effort */ }
}

// Detect connection state for a keyless CLI provider and, when not connected,
// offer an inline action. Returns:
//   null                 already connected / not a CLI-login provider / can't prompt
//   { exit:true }        a foreground action was queued (ctx.requestLogin set)
//   { exit:false, msg }  handled inline (key saved / skipped / cancelled)
export async function maybeLoginForCli(ctx, provName, { promptText, statusDeps } = {}) {
  const spec = CLI_LOGIN_PROVIDERS[provName];
  if (!spec) return null;
  if (typeof ctx.openPicker !== 'function') return null;
  const hasStoredKey = typeof ctx.resolveAuthKey === 'function' && !!ctx.resolveAuthKey(provName);
  let status;
  try {
    status = await cliLoginStatus(provName, { hasStoredKey, ...(statusDeps || {}) });
  } catch (_) {
    return null; // detection failure must not block the provider switch
  }
  if (!status.supported || status.loggedIn) return null;

  const items = [];
  if (status.binMissing) {
    items.push({ id: 'install', label: `▶ install ${spec.pkg}`, desc: `runs: npm i -g ${spec.pkg} (then sign in)` });
  } else {
    items.push({ id: 'browser', label: '▶ log in via browser', desc: `runs: ${spec.browserHint}` });
  }
  items.push({ id: 'apikey', label: 'paste an API key instead', desc: spec.apiKeyHint });
  items.push({ id: 'skip', label: 'skip for now', desc: `connect later via /login ${provName}` });

  const picked = await ctx.openPicker({
    kind: 'menu',
    title: `${provName} — not connected`,
    subtitle: status.binMissing ? `the \`${spec.bin}\` CLI is not installed` : `\`${spec.bin}\` is installed but not signed in`,
    items,
  });
  const id = picked && typeof picked === 'object' ? picked.id : picked;
  if (!id || id === 'skip') {
    return { exit: false, msg: `provider → ${provName}  (not connected — run /login ${provName} when ready)` };
  }
  if (id === 'browser' || id === 'install') {
    ctx.requestLogin = { provider: provName, mode: id };
    return { exit: true };
  }
  // id === 'apikey'
  const key = typeof promptText === 'function'
    ? await promptText(ctx, { title: `${provName} — API key`, subtitle: spec.apiKeyHint })
    : null;
  if (!key) return { exit: false, msg: 'cancelled' };
  if (provName === 'codex-cli') {
    // codex persists the key itself via `codex login --with-api-key` (stdin),
    // which needs a subprocess — defer to the foreground guard.
    ctx.requestLogin = { provider: provName, mode: 'apikey', apiKey: key };
    return { exit: true };
  }
  // gemini: save the key in lazyclaw; the provider injects it as GEMINI_API_KEY.
  if (typeof ctx.readConfig === 'function' && typeof ctx.writeConfig === 'function') {
    const next = setAuthKey({ readConfig: ctx.readConfig, writeConfig: ctx.writeConfig, provider: provName, key });
    if (ctx.cfg && next) { ctx.cfg.authProfiles = next.authProfiles; ctx.cfg.authActiveProfile = next.authActiveProfile; }
  }
  return { exit: false, msg: `✓ ${provName} API key saved — provider → ${provName}` };
}

// Called from /provider after a keyless CLI provider is selected. Returns a
// string to surface (or 'EXIT' to hand off to the foreground login), or null
// to let /provider print its default "provider → x" line.
export async function runProviderLogin(ctx, provName, deps = {}) {
  const login = await maybeLoginForCli(ctx, provName, deps);
  if (login && login.exit) { _persistProvider(ctx, provName); return 'EXIT'; }
  return (login && login.msg) ? login.msg : null;
}

// `/login [provider]` — connect a keyless CLI provider without leaving chat.
export async function loginSlash(args, ctx, deps = {}) {
  const provName = (args && args.trim()) || (ctx.getActiveProvName ? ctx.getActiveProvName() : '');
  const spec = CLI_LOGIN_PROVIDERS[provName];
  if (!spec) {
    const known = Object.keys(CLI_LOGIN_PROVIDERS).join(' · ');
    return `/login is for the keyless CLI providers (${known}). Current: ${provName || '(none)'}.`;
  }
  if (typeof ctx.openPicker !== 'function') {
    return `/login needs the interactive UI. To connect ${provName}, run \`${spec.browserHint}\` in a shell, or set an API key.`;
  }
  const login = await maybeLoginForCli(ctx, provName, deps);
  if (login && login.exit) {
    _persistProvider(ctx, provName);
    if (ctx.setActiveProvName) ctx.setActiveProvName(provName);
    return 'EXIT';
  }
  if (login && login.msg) return login.msg;
  return `${provName} is already connected.`;
}
