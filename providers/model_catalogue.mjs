// providers/model_catalogue.mjs — shared OpenAI-compatible model-catalogue
// resolution.
//
// Extracted from cli.mjs (`_modelCatalogueFor` / `_fetchModelsForProvider`)
// so BOTH the legacy readline picker (cli.mjs) and the Ink slash dispatcher
// (tui/slash_dispatcher.mjs) can offer the same live `/v1/models` fetch
// without duplicating the provider -> endpoint resolution. v5.4's Ink port
// dropped this affordance from `/model`; this module restores it for both
// paths from one place.
//
// Dependency-injected (no cli.mjs internals) so it stays import-light and
// unit-testable with no network.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readClaudeKeychainToken } from './claude_keychain.mjs';

/**
 * Whether a provider exposes a model catalogue we can live-fetch. True for
 * openai, ollama, any builtin OpenAI-compat vendor (nim / openrouter / groq /
 * together / xai / deepseek / mistral / fireworks), any provider carrying an
 * explicit `baseUrl` (custom endpoints), and — via their NATIVE list
 * endpoints — anthropic (`GET /v1/models`) and gemini
 * (`GET /v1beta/models`). False for claude-cli (keyless subprocess, no
 * catalogue endpoint) / mock / orchestrator.
 *
 * @param {object} meta       PROVIDER_INFO[providerId]
 * @param {string} providerId
 * @returns {boolean}
 */
export function supportsLiveFetch(meta, providerId) {
  const m = meta || {};
  return !!m.baseUrl
    || providerId === 'openai'
    || providerId === 'ollama'
    || providerId === 'anthropic'
    || providerId === 'gemini'
    // Keyless CLI providers borrow the credential their vendor accepts
    // (anthropic key / Claude Code OAuth token; gemini key; openai key or
    // a plain key stored in ~/.codex/auth.json) — best-effort with an
    // honest, actionable error when none is available.
    || providerId === 'claude-cli'
    || providerId === 'gemini-cli'
    || providerId === 'codex-cli'
    || !!m.builtinOpenAICompat;
}

// A hanging endpoint used to leave these calls pending until the OS gave up on
// the TCP connection. The blast radius was already bounded — model_cache.mjs
// applies each provider's result independently as it settles, so one hang only
// ever delayed that provider's own cache entry — but the refresh tick's own
// promise stayed unresolved for minutes. Ten seconds is far above any healthy
// /v1/models response and far below an OS-level connect timeout.
//
// AbortSignal.timeout needs Node 17.3+; this project requires 18+.
const MODELS_FETCH_TIMEOUT_MS = 10_000;

// A timed-out fetch rejects with a DOMException named TimeoutError, whose
// message ("The operation was aborted due to timeout") names neither the
// provider nor the timeout. Callers surface these strings, so translate it.
async function fetchWithTimeout(f, url, init, label) {
  try {
    return await f(url, { ...init, signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS) });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(`${label} timed out after ${MODELS_FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  }
}

/**
 * Live-list Anthropic models via the native Models API. Surfaces newly
 * released models (e.g. claude-fable-5) the day they ship instead of waiting
 * for a curated-list update. Sorted, deduped.
 *
 * @param {{apiKey:string, fetchImpl?:typeof fetch}} opts
 * @returns {Promise<string[]>}
 */
export async function fetchAnthropicModels({ apiKey, oauthToken, fetchImpl } = {}) {
  if (!apiKey && !oauthToken) throw new Error('anthropic model listing requires an api key (set ANTHROPIC_API_KEY or configure the provider)');
  const f = fetchImpl || globalThis.fetch;
  // OAuth tokens (Claude Code subscription login) authenticate with a Bearer
  // header plus the documented oauth beta header; api keys use x-api-key.
  const auth = apiKey
    ? { 'x-api-key': apiKey }
    : { 'authorization': `Bearer ${oauthToken}`, 'anthropic-beta': 'oauth-2025-04-20' };
  const res = await fetchWithTimeout(f, 'https://api.anthropic.com/v1/models?limit=1000', {
    method: 'GET',
    headers: { ...auth, 'anthropic-version': '2023-06-01', 'accept': 'application/json' },
  }, 'anthropic /v1/models');
  if (!res.ok) throw new Error(`anthropic /v1/models returned HTTP ${res.status}`);
  const obj = await res.json();
  const ids = (Array.isArray(obj?.data) ? obj.data : [])
    .map((m) => m && m.id)
    .filter((id) => typeof id === 'string');
  return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
}

/**
 * Live-list Gemini models via the Generative Language API, keeping only
 * chat-capable entries (supportedGenerationMethods includes
 * generateContent) and stripping the `models/` resource prefix.
 *
 * @param {{apiKey:string, fetchImpl?:typeof fetch}} opts
 * @returns {Promise<string[]>}
 */
export async function fetchGeminiModels({ apiKey, fetchImpl } = {}) {
  if (!apiKey) throw new Error('gemini model listing requires an api key (set GEMINI_API_KEY or configure the provider)');
  const f = fetchImpl || globalThis.fetch;
  const res = await fetchWithTimeout(f, `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`, {
    method: 'GET',
    headers: { 'accept': 'application/json' },
  }, 'gemini models list');
  if (!res.ok) throw new Error(`gemini models list returned HTTP ${res.status}`);
  const obj = await res.json();
  const ids = (Array.isArray(obj?.models) ? obj.models : [])
    .filter((m) => Array.isArray(m?.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''))
    .filter(Boolean);
  return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve `{ baseUrl, apiKey }` for a provider's OpenAI-compatible
 * `/v1/models` endpoint. Returns `null` when the provider has no such
 * catalogue (anthropic / gemini / claude-cli / mock / orchestrator).
 *
 * @param {object} deps
 * @param {object} deps.cfg            on-disk config (for cfg.customProviders / cfg['api-key'])
 * @param {object} deps.registryMod    provides PROVIDER_INFO
 * @param {(providerId:string)=>string} deps.resolveAuthKey  env/profile key resolver
 * @param {string} deps.providerId
 * @returns {{baseUrl:string, apiKey:string}|null}
 */
export function modelCatalogueFor({ cfg, registryMod, resolveAuthKey, providerId } = {}) {
  const info = (registryMod && registryMod.PROVIDER_INFO) || {};
  const meta = info[providerId] || {};
  const key = (id) => (typeof resolveAuthKey === 'function' ? resolveAuthKey(id) : '') || '';

  if (meta.custom && meta.baseUrl) {
    const list = (cfg && cfg.customProviders) || [];
    const entry = list.find((p) => p && p.name === providerId) || {};
    return { baseUrl: meta.baseUrl, apiKey: entry.apiKey || (cfg && cfg['api-key']) || '' };
  }
  // Built-in OpenAI-compatible vendors expose a baseUrl; the auth-key
  // resolver already knows the env-var fallback chain.
  if (meta.builtinOpenAICompat && meta.baseUrl) {
    return { baseUrl: meta.baseUrl, apiKey: key(providerId) };
  }
  if (providerId === 'openai') {
    return { baseUrl: 'https://api.openai.com/v1', apiKey: key('openai') };
  }
  if (providerId === 'ollama') {
    const host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
    return { baseUrl: `${host.replace(/\/$/, '')}/v1`, apiKey: '' };
  }
  return null;
}

/**
 * Live-fetch the provider's `/v1/models` list. Throws when the provider has
 * no OpenAI-compatible catalogue. Returns a string[] of model ids.
 *
 * @param {object} deps  same shape as {@link modelCatalogueFor}
 * @returns {Promise<string[]>}
 */
// Claude Code OAuth token from the credential store `claude login` writes on
// Linux / non-keychain setups. On macOS the token lives in the OS Keychain
// (no file), so this returns null there — the caller falls through to its
// honest "set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN" error. Read-only;
// the token is only ever sent to api.anthropic.com, never logged.
export function _claudeCodeOAuthToken({ home, readFileSync, keychainReader } = {}) {
  const h = home || os.homedir();
  const read = readFileSync || fs.readFileSync;
  for (const rel of ['.claude/.credentials.json', '.config/claude/.credentials.json']) {
    try {
      const j = JSON.parse(read(path.join(h, rel), 'utf8'));
      const tok = j?.claudeAiOauth?.accessToken || j?.accessToken || j?.access_token;
      if (typeof tok === 'string' && tok) return tok;
    } catch { /* missing / unreadable / not JSON — try the next location */ }
  }
  // macOS keeps the login in the Keychain (no file) — read it there.
  const fromKeychain = (keychainReader || readClaudeKeychainToken)();
  return fromKeychain || null;
}

// A plain API key stored by `codex login --api-key` in ~/.codex/auth.json.
// ChatGPT-OAuth logins store an empty OPENAI_API_KEY object plus OAuth
// tokens — those do NOT authenticate the platform /v1/models endpoint, so
// they are deliberately ignored.
export function _codexStoredApiKey({ home, readFileSync } = {}) {
  const h = home || os.homedir();
  const read = readFileSync || fs.readFileSync;
  try {
    const j = JSON.parse(read(path.join(h, '.codex/auth.json'), 'utf8'));
    const k = j?.OPENAI_API_KEY;
    if (typeof k === 'string' && k) return k;
    if (k && typeof k === 'object' && typeof k.value === 'string' && k.value) return k.value;
  } catch { /* missing / unreadable */ }
  return null;
}

// A ChatGPT-plan `codex` login has no platform API key, so /v1/models can't be
// listed. The one model such a login can actually use is the one configured in
// ~/.codex/config.toml (`model = "gpt-5.5"`). Return it so the picker shows the
// account's real model instead of a "fetch failed" error. Returns [] when the
// file is missing or has no model line.
export function _codexConfigModels({ home, readFileSync } = {}) {
  const h = home || os.homedir();
  const read = readFileSync || fs.readFileSync;
  try {
    const txt = read(path.join(h, '.codex/config.toml'), 'utf8');
    const m = /^\s*model\s*=\s*"([^"]+)"/m.exec(String(txt));
    return m && m[1] ? [m[1]] : [];
  } catch { return []; }
}

// The codex CLI keeps the models the signed-in account can actually use in
// ~/.codex/models_cache.json, refreshed by codex itself. That is a much better
// answer than config.toml's single pinned `model` line, which only says which
// one is currently selected — a ChatGPT-plan login otherwise saw exactly one
// entry in the picker while the cache listed every available model.
//
// Shape (codex-cli 0.146): { fetched_at, etag, client_version, models: [
//   { slug, display_name, visibility, priority, … } ] }. `visibility: "hide"`
// marks internal entries (e.g. codex-auto-review) that must not be offered;
// `priority` ascending is codex's own preferred ordering. Returns [] for a
// missing, malformed, or empty cache so the config.toml fallback still applies.
export function _codexCachedModels({ home, readFileSync } = {}) {
  const h = home || os.homedir();
  const read = readFileSync || fs.readFileSync;
  try {
    const j = JSON.parse(read(path.join(h, '.codex/models_cache.json'), 'utf8'));
    if (!Array.isArray(j?.models)) return [];
    return j.models
      .filter((m) => m && m.visibility !== 'hide' && typeof m.slug === 'string' && m.slug)
      .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
      .map((m) => m.slug);
  } catch { return []; }
}

// Same idea for a `gemini` Google-account login: no listable platform catalogue,
// but ~/.gemini/settings.json may pin a model. Returns [] when absent.
export function _geminiConfigModels({ home, readFileSync } = {}) {
  const h = home || os.homedir();
  const read = readFileSync || fs.readFileSync;
  try {
    const obj = JSON.parse(read(path.join(h, '.gemini/settings.json'), 'utf8'));
    const m = obj && (obj.model || obj.defaultModel || (obj.model && obj.model.name));
    return typeof m === 'string' && m ? [m] : [];
  } catch { return []; }
}

export async function fetchModelsForProvider(deps) {
  const providerId = deps && deps.providerId;
  const key = (id) => (typeof deps?.resolveAuthKey === 'function' ? deps.resolveAuthKey(id) : '') || '';
  const credReader = deps?._credReader; // test seam: () => token|null per helper
  // Native-API providers list through their own endpoints (they are not
  // OpenAI-compatible). Env fallbacks cover the common keyless-config case.
  if (providerId === 'anthropic') {
    return fetchAnthropicModels({ apiKey: key('anthropic') || process.env.ANTHROPIC_API_KEY || '', fetchImpl: deps?.fetchImpl });
  }
  if (providerId === 'gemini') {
    return fetchGeminiModels({ apiKey: key('gemini') || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '', fetchImpl: deps?.fetchImpl });
  }
  // Keyless CLI providers: borrow the credential their vendor accepts.
  if (providerId === 'claude-cli') {
    const apiKey = key('claude-cli') || key('anthropic') || process.env.ANTHROPIC_API_KEY || '';
    if (apiKey) return fetchAnthropicModels({ apiKey, fetchImpl: deps?.fetchImpl });
    const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
      || (credReader ? credReader('claude') : _claudeCodeOAuthToken());
    if (oauthToken) return fetchAnthropicModels({ oauthToken, fetchImpl: deps?.fetchImpl });
    throw new Error('claude-cli model listing needs a credential: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (on macOS the `claude` login lives in the Keychain, which is not readable here)');
  }
  if (providerId === 'gemini-cli') {
    const apiKey = key('gemini-cli') || key('gemini') || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    if (apiKey) return fetchGeminiModels({ apiKey, fetchImpl: deps?.fetchImpl });
    // Google-account login can't list a platform catalogue — surface the model
    // pinned in ~/.gemini/settings.json (if any) instead of throwing.
    return deps?._geminiConfigModels ? deps._geminiConfigModels() : _geminiConfigModels();
  }
  if (providerId === 'codex-cli') {
    const apiKey = key('codex-cli') || key('openai') || process.env.OPENAI_API_KEY
      || (credReader ? credReader('codex') : _codexStoredApiKey()) || '';
    if (apiKey) {
      const { fetchOpenAICompatModels } = await import('./openai_compat.mjs');
      return fetchOpenAICompatModels({ baseUrl: 'https://api.openai.com/v1', apiKey, fetch: deps?.fetchImpl });
    }
    // ChatGPT-plan login has no platform API key, so /v1/models is unavailable.
    // Prefer codex's own cache of what the account can use; fall back to the
    // single model config.toml pins when the cache is missing or unreadable.
    const cached = deps?._codexCachedModels ? deps._codexCachedModels() : _codexCachedModels();
    if (cached.length > 0) return cached;
    return deps?._codexConfigModels ? deps._codexConfigModels() : _codexConfigModels();
  }
  const c = modelCatalogueFor(deps);
  if (!c) {
    throw new Error(`provider "${providerId}" does not expose a model catalogue endpoint`);
  }
  const { fetchOpenAICompatModels } = await import('./openai_compat.mjs');
  return fetchOpenAICompatModels({ baseUrl: c.baseUrl, apiKey: c.apiKey, fetch: deps?.fetchImpl });
}
