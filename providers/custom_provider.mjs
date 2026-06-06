// providers/custom_provider.mjs — register a custom OpenAI-compatible
// endpoint (NIM / OpenRouter / Together / Groq / vLLM / LM Studio / …).
//
// Extracted from cli.mjs `_addCustomProviderInteractive` so the persistence +
// live-probe logic is shared between the legacy readline wizard and the Ink
// provider picker (which lost this affordance in v5.4). The original mixed
// raw-ANSI prompts with the persistence; this is the IO-free core, dependency-
// injected on registry + config readers/writers so it unit-tests with no disk
// or network. The caller owns collecting name/baseUrl/apiKey and rendering.

export function validateCustomBaseUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) throw new Error('baseUrl is required');
  if (!/^https?:\/\//i.test(s)) throw new Error('baseUrl must start with http:// or https://');
  return s.replace(/\/+$/, '');
}

/**
 * Validate, persist, hot-register, and best-effort probe a custom provider.
 *
 * @param {object} deps
 * @param {object} deps.registry      registry module — needs validateCustomProviderName,
 *                                     registerCustomProviders, fetchOpenAICompatModels,
 *                                     and (optional) isBuiltinOpenAICompatName
 * @param {()=>object} deps.readConfig
 * @param {(cfg:object)=>void} deps.writeConfig
 * @param {string} deps.name
 * @param {string} deps.baseUrl
 * @param {string} [deps.apiKey]
 * @returns {Promise<{name:string, baseUrl:string, builtinOverride:boolean, probe:{ok:boolean,count:number,error:?string,models:string[]}}>}
 */
export async function addCustomProvider({ registry, readConfig, writeConfig, name, baseUrl, apiKey }) {
  const vName = registry.validateCustomProviderName(name); // throws on bad name
  const vUrl = validateCustomBaseUrl(baseUrl);
  const builtinOverride = typeof registry.isBuiltinOpenAICompatName === 'function'
    && !!registry.isBuiltinOpenAICompatName(vName);

  // Persist to cfg.customProviders[], overwriting an existing same-name entry.
  const cfg = readConfig();
  cfg.customProviders = Array.isArray(cfg.customProviders) ? cfg.customProviders : [];
  const idx = cfg.customProviders.findIndex((p) => p && p.name === vName);
  const entry = { name: vName, baseUrl: vUrl, apiKey: apiKey ? String(apiKey) : undefined };
  if (idx >= 0) cfg.customProviders[idx] = { ...cfg.customProviders[idx], ...entry };
  else cfg.customProviders.push(entry);
  writeConfig(cfg);
  registry.registerCustomProviders(cfg);

  // Best-effort live model probe. Registration still succeeds on failure —
  // the model picker's free-text/refetch row covers it.
  const probe = { ok: false, count: 0, error: null, models: [] };
  try {
    const list = await registry.fetchOpenAICompatModels({ baseUrl: vUrl, apiKey: entry.apiKey || '' });
    probe.ok = true;
    probe.models = Array.isArray(list) ? list.slice(0, 50) : [];
    probe.count = probe.models.length;
    if (probe.models.length) {
      const updated = readConfig();
      const i = (updated.customProviders || []).findIndex((p) => p && p.name === vName);
      if (i >= 0) {
        updated.customProviders[i].suggestedModels = probe.models;
        if (!updated.customProviders[i].defaultModel) updated.customProviders[i].defaultModel = probe.models[0];
        writeConfig(updated);
        registry.registerCustomProviders(updated);
      }
    }
  } catch (e) {
    probe.error = e && e.message ? e.message : String(e);
  }
  return { name: vName, baseUrl: vUrl, builtinOverride, probe };
}
