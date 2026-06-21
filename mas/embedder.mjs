// mas/embedder.mjs — pluggable, opt-in text-embedding source for hybrid recall.
//
// Recall (mas/index_db.mjs) blends FTS5 bm25 with semantic similarity; the query
// + document vectors come from here. This is OFF by default: getEmbedder returns
// null unless cfg.recall.embeddings.enabled === true AND a source resolves, in
// which case recall rides today's pure-FTS5 path unchanged.
//
// HONESTY (§1, §9): the bare $0 chat-subscription user (claude-cli / gemini-cli /
// codex-cli spawn local chat binaries with no embed subcommand; the Anthropic
// API has no embeddings endpoint) has NO embedding source — getEmbedder returns
// null for them and they get pure FTS5. We deliberately do NOT bundle a heavy
// local model (onnxruntime + weights are 50-150MB) to fake a semantic path for
// a user who never asked for it. Embeddings light up only when a user opts in
// with an OpenAI/Gemini API key, or a local Ollama embed model (zero npm
// footprint — it talks to the user's own ollama server).

const DEFAULTS = {
  openai: { model: 'text-embedding-3-small', dims: 1536, url: 'https://api.openai.com/v1/embeddings' },
  gemini: { model: 'text-embedding-004', dims: 768, base: 'https://generativelanguage.googleapis.com/v1beta' },
  ollama: { model: 'nomic-embed-text', dims: 768, url: 'http://127.0.0.1:11434/api/embeddings' },
};

let _override = null;
// Test seam: inject a fake embedder ({ id, dims, embed }) or a falsy value to
// force the null (pure-FTS) path. Pass undefined to clear the override.
export function __setEmbedder(fn) { _override = fn === undefined ? null : fn; }

function toF32(arr) {
  return arr instanceof Float32Array ? arr : Float32Array.from(arr || []);
}

async function _openaiEmbed(texts, { model, apiKey, url, fetchImpl }) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ input: texts, model }),
  });
  if (!res.ok) throw new Error(`openai embeddings HTTP ${res.status}`);
  const json = await res.json();
  return (json.data || []).map((d) => toF32(d.embedding));
}

async function _geminiEmbed(texts, { model, apiKey, base, fetchImpl }) {
  const url = `${base.replace(/\/$/, '')}/models/${model}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requests: texts.map((t) => ({ model: `models/${model}`, content: { parts: [{ text: String(t) }] } })) }),
  });
  if (!res.ok) throw new Error(`gemini embeddings HTTP ${res.status}`);
  const json = await res.json();
  return (json.embeddings || []).map((e) => toF32(e.values));
}

async function _ollamaEmbed(texts, { model, url, fetchImpl }) {
  // The classic /api/embeddings endpoint takes one prompt at a time.
  const out = [];
  for (const t of texts) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: String(t) }),
    });
    if (!res.ok) throw new Error(`ollama embeddings HTTP ${res.status}`);
    const json = await res.json();
    out.push(toF32(json.embedding));
  }
  return out;
}

/**
 * Resolve the configured embedding source, or null (→ pure FTS5 recall).
 * @returns {{ id: string, dims: number, embed: (texts: string[]) => Promise<Float32Array[]> } | null}
 */
export function getEmbedder(cfg, opts = {}) {
  if (_override !== null) return _override;
  const e = cfg?.recall?.embeddings;
  if (!e || e.enabled !== true) return null;
  const provider = String(e.provider || '').toLowerCase();
  const d = DEFAULTS[provider];
  if (!d) return null;
  const model = e.model || d.model;
  const dims = Number(e.dim) || d.dims;
  const apiKey = e.apiKey || opts.apiKey || cfg['api-key'] || '';
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;
  // openai/gemini need a key; ollama is keyless (local server).
  if ((provider === 'openai' || provider === 'gemini') && !apiKey) return null;
  return {
    id: `${provider}/${model}`,
    dims,
    async embed(texts) {
      const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? ''));
      if (!list.length) return [];
      if (provider === 'openai') return _openaiEmbed(list, { model, apiKey, url: e.url || d.url, fetchImpl });
      if (provider === 'gemini') return _geminiEmbed(list, { model, apiKey, base: e.baseUrl || d.base, fetchImpl });
      return _ollamaEmbed(list, { model, url: e.url || d.url, fetchImpl });
    },
  };
}
