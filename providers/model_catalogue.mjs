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
    || !!m.builtinOpenAICompat;
}

/**
 * Live-list Anthropic models via the native Models API. Surfaces newly
 * released models (e.g. claude-fable-5) the day they ship instead of waiting
 * for a curated-list update. Sorted, deduped.
 *
 * @param {{apiKey:string, fetchImpl?:typeof fetch}} opts
 * @returns {Promise<string[]>}
 */
export async function fetchAnthropicModels({ apiKey, fetchImpl } = {}) {
  if (!apiKey) throw new Error('anthropic model listing requires an api key (set ANTHROPIC_API_KEY or configure the provider)');
  const f = fetchImpl || globalThis.fetch;
  const res = await f('https://api.anthropic.com/v1/models?limit=1000', {
    method: 'GET',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'accept': 'application/json' },
  });
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
  const res = await f(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`, {
    method: 'GET',
    headers: { 'accept': 'application/json' },
  });
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
export async function fetchModelsForProvider(deps) {
  const providerId = deps && deps.providerId;
  const key = (id) => (typeof deps?.resolveAuthKey === 'function' ? deps.resolveAuthKey(id) : '') || '';
  // Native-API providers list through their own endpoints (they are not
  // OpenAI-compatible). Env fallbacks cover the common keyless-config case.
  if (providerId === 'anthropic') {
    return fetchAnthropicModels({ apiKey: key('anthropic') || process.env.ANTHROPIC_API_KEY || '', fetchImpl: deps?.fetchImpl });
  }
  if (providerId === 'gemini') {
    return fetchGeminiModels({ apiKey: key('gemini') || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '', fetchImpl: deps?.fetchImpl });
  }
  const c = modelCatalogueFor(deps);
  if (!c) {
    throw new Error(`provider "${providerId}" does not expose a model catalogue endpoint`);
  }
  const { fetchOpenAICompatModels } = await import('./openai_compat.mjs');
  return fetchOpenAICompatModels({ baseUrl: c.baseUrl, apiKey: c.apiKey, fetch: deps?.fetchImpl });
}
