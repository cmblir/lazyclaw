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
 * Whether a provider exposes an OpenAI-compatible `/v1/models` catalogue we
 * can live-fetch. True for openai, ollama, any builtin OpenAI-compat vendor
 * (nim / openrouter / groq / together / xai / deepseek / mistral /
 * fireworks), and any provider carrying an explicit `baseUrl` (custom
 * endpoints). False for anthropic / gemini / claude-cli / mock /
 * orchestrator.
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
    || !!m.builtinOpenAICompat;
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
  const c = modelCatalogueFor(deps);
  const providerId = deps && deps.providerId;
  if (!c) {
    throw new Error(`provider "${providerId}" does not expose an OpenAI-compatible /v1/models endpoint`);
  }
  const { fetchOpenAICompatModels } = await import('./openai_compat.mjs');
  return fetchOpenAICompatModels({ baseUrl: c.baseUrl, apiKey: c.apiKey });
}
